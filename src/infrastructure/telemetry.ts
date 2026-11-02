import { randomUUID } from 'node:crypto';

import {
  context,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Counter,
  type Histogram,
} from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import type { MiddlewareHandler } from 'hono';

import type { EmailTemplate } from '../app/email';

import { version } from '../../package.json';

const SERVICE_NAME = 'notifications-api';
const INSTANCE_ID = randomUUID();
const HTTP_DURATION_BOUNDARIES = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.3, 0.4, 0.5, 0.75, 0.8, 1, 2.5, 5, 7.5, 10,
];
const HTTP_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'CONNECT',
  'OPTIONS',
  'TRACE',
  'PATCH',
]);
let requestDuration: Histogram | undefined;
let consumedMessages: Counter | undefined;
let failedMessages: Counter | undefined;
let discardedMessages: Counter | undefined;
let processingDuration: Histogram | undefined;
let sentEmails: Counter | undefined;
let failedEmails: Counter | undefined;

// Kubernetes probes hit these every few seconds. A span and a log line per
// probe would bury the requests somebody actually made.
const PROBE_PATHS: Record<string, true> = { '/healthcheck': true, '/livez': true };

export interface Telemetry {
  tracerProvider: BasicTracerProvider;
  loggerProvider: LoggerProvider;
  meterProvider: MeterProvider;
}

/**
 * Joins every request to the caller's W3C trace context and, given exporters,
 * sends the service's spans and logs over OTLP. Same setup as the gateway
 * (ADR-013).
 *
 * Without exporters nothing is recorded, but the caller's trace id still
 * reaches the error responses.
 */
export function startTelemetry(exporters?: {
  spans: SpanExporter;
  logs: LogRecordExporter;
  metrics: PushMetricExporter;
}): Telemetry | undefined {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  if (!exporters) {
    return undefined;
  }

  const resource = resourceFromAttributes({
    'service.name': SERVICE_NAME,
    'service.version': version,
    'service.instance.id': INSTANCE_ID,
  });
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporters.spans)],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: exporters.logs })],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: exporters.metrics })],
  });
  const meter = meterProvider.getMeter(SERVICE_NAME);
  requestDuration = meter.createHistogram('http.server.request.duration', {
    unit: 's',
    description: 'Duration of HTTP server requests.',
    advice: { explicitBucketBoundaries: HTTP_DURATION_BOUNDARIES },
  });
  consumedMessages = meter.createCounter('udesa.messaging.consumed');
  failedMessages = meter.createCounter('udesa.messaging.failed');
  discardedMessages = meter.createCounter('udesa.messaging.dead_letter');
  processingDuration = meter.createHistogram('udesa.messaging.processing.duration', {
    unit: 's',
    advice: { explicitBucketBoundaries: HTTP_DURATION_BOUNDARIES },
  });
  sentEmails = meter.createCounter('udesa.email.sent');
  failedEmails = meter.createCounter('udesa.email.failed');
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  return { tracerProvider, loggerProvider, meterProvider };
}

/** Opens a span per request, joining the caller's trace, and logs each request. */
export const requestTelemetry: MiddlewareHandler = async (c, next) => {
  if (PROBE_PATHS[c.req.path]) {
    return next();
  }

  const { method, path } = c.req;
  const parent = propagation.extract(ROOT_CONTEXT, c.req.header());
  const span = trace
    .getTracer(SERVICE_NAME)
    .startSpan(`${method} ${path}`, { kind: SpanKind.SERVER }, parent);
  const active = trace.setSpan(parent, span);
  const started = performance.now();

  await context.with(active, async () => {
    let failed = false;
    try {
      await next();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const status = failed ? 500 : c.res.status;
      const elapsedSeconds = (performance.now() - started) / 1000;
      const route = c.req.routePath;
      requestDuration?.record(
        elapsedSeconds,
        {
          'http.request.method': HTTP_METHODS.has(method) ? method : '_OTHER',
          'http.response.status_code': status,
          ...(route && !route.includes('*') ? { 'http.route': route } : {}),
        },
        active
      );
      const attributes = {
        'http.request.method': method,
        'url.path': path,
        'http.response.status_code': status,
      };
      span.setAttributes(attributes);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      logs.getLogger(SERVICE_NAME).emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: `${method} ${path} ${status}`,
        attributes: { ...attributes, duration_ms: Math.round(elapsedSeconds * 10000) / 10 },
        context: active,
      });
      span.end();
    }
  });
};

/** The trace id of the request being served, or undefined outside of one. */
export function currentTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}

const SEVERITIES = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

/**
 * Logs something that is not a request, like a broker disconnect. Goes to
 * stdout too: without an OTLP endpoint, as in development, that is the only
 * place it shows up.
 */
export function logEvent(
  level: keyof typeof SEVERITIES,
  body: string,
  attributes: Record<string, string> = {}
): void {
  console[level](body, ...(Object.keys(attributes).length > 0 ? [attributes] : []));
  logs.getLogger(SERVICE_NAME).emit({
    severityNumber: SEVERITIES[level],
    severityText: level.toUpperCase(),
    body,
    attributes,
  });
}

export function recordMessageStarted(queue: string): void {
  consumedMessages?.add(1, { 'messaging.destination.name': queue });
}

export function recordMessageFinished(
  queue: string,
  outcome: 'ack' | 'dead-letter' | 'failed',
  durationSeconds: number
): void {
  const attributes = { 'messaging.destination.name': queue };
  if (outcome === 'failed') failedMessages?.add(1, attributes);
  if (outcome === 'dead-letter') discardedMessages?.add(1, attributes);
  processingDuration?.record(durationSeconds, attributes);
}

export function recordEmailResult(template: EmailTemplate, outcome: 'sent' | 'failed'): void {
  const counter = outcome === 'sent' ? sentEmails : failedEmails;
  counter?.add(1, { template });
}
