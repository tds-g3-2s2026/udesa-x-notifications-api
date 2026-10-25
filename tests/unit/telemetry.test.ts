import { SpanStatusCode } from '@opentelemetry/api';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTelemetry, type Telemetry } from '../../src/infrastructure/telemetry';
import { buildApp } from '../support/app';

const CALLER_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const CALLER_TRACEPARENT = `00-${CALLER_TRACE_ID}-00f067aa0ba902b7-01`;

const spans = new InMemorySpanExporter();
const logRecords = new InMemoryLogRecordExporter();
let telemetry: Telemetry;

const app = buildApp();
app.get('/broken', () => {
  throw new Error('boom');
});

beforeAll(() => {
  telemetry = startTelemetry({ spans, logs: logRecords })!;
});

afterAll(async () => {
  await telemetry.tracerProvider.shutdown();
  await telemetry.loggerProvider.shutdown();
});

beforeEach(() => {
  spans.reset();
  logRecords.reset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

async function call(path: string, headers: Record<string, string> = {}) {
  const res = await app.request(path, { headers });
  await telemetry.tracerProvider.forceFlush();
  await telemetry.loggerProvider.forceFlush();
  return res;
}

describe('request span', () => {
  it("joins the caller's trace", async () => {
    await call('/api/anything', { traceparent: CALLER_TRACEPARENT });

    const [span] = spans.getFinishedSpans();
    expect(span.spanContext().traceId).toBe(CALLER_TRACE_ID);
    expect(span.name).toBe('GET /api/anything');
  });

  it('is marked as an error on a 500', async () => {
    await call('/broken');

    const [span] = spans.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('request log', () => {
  it('logs each request with its trace and its outcome, without the query string', async () => {
    await call('/api/anything?token=secret', { traceparent: CALLER_TRACEPARENT });

    const records = logRecords.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].body).toBe('GET /api/anything 404');
    expect(records[0].spanContext?.traceId).toBe(CALLER_TRACE_ID);
    expect(JSON.stringify([records[0].body, records[0].attributes])).not.toContain('secret');
  });
});

describe('error responses', () => {
  it("carry the request's trace id, the same one the error log has", async () => {
    const res = await call('/broken', { traceparent: CALLER_TRACEPARENT });

    expect(await res.json()).toMatchObject({ traceId: CALLER_TRACE_ID });
    const errorLog = logRecords.getFinishedLogRecords().find((r) => r.severityText === 'ERROR');
    expect(errorLog?.attributes.traceId).toBe(CALLER_TRACE_ID);
    expect(String(errorLog?.attributes.error)).toContain('boom');
  });
});

describe('probes', () => {
  it('produce no span and no request log', async () => {
    await call('/healthcheck');
    await call('/livez');

    expect(spans.getFinishedSpans()).toEqual([]);
    expect(logRecords.getFinishedLogRecords()).toEqual([]);
  });
});
