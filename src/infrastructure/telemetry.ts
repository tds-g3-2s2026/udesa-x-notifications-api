import {
  context,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
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
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import type { MiddlewareHandler } from 'hono';

import { version } from '../../package.json';

const SERVICE_NAME = 'notifications-api';

// Kubernetes probes hit these every few seconds. A span and a log line per
// probe would bury the requests somebody actually made.
const PROBE_PATHS: Record<string, true> = { '/healthcheck': true, '/livez': true };

export interface Telemetry {
  tracerProvider: BasicTracerProvider;
  loggerProvider: LoggerProvider;
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
}): Telemetry | undefined {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  if (!exporters) {
    return undefined;
  }

  const resource = resourceFromAttributes({
    'service.name': SERVICE_NAME,
    'service.version': version,
  });
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporters.spans)],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: exporters.logs })],
  });
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  return { tracerProvider, loggerProvider };
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

  await context.with(active, next);

  const status = c.res.status;
  // The path only: a query string can carry a token.
  const attributes = {
    'http.request.method': method,
    'url.path': path,
    'http.response.status_code': status,
  };
  span.setAttributes(attributes);
  if (status >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
  logs.getLogger(SERVICE_NAME).emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: `${method} ${path} ${status}`,
    attributes: { ...attributes, duration_ms: Math.round((performance.now() - started) * 10) / 10 },
    context: active,
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
