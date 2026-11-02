import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { Hono } from 'hono';
import { expect, it } from 'vitest';

import {
  recordEmailResult,
  recordMessageFinished,
  recordMessageStarted,
  requestTelemetry,
  startTelemetry,
} from '../../src/infrastructure/telemetry';

it('exports request, queue and email metrics as OTLP protobuf with bounded attributes', async () => {
  const received: { contentType: string; authorization: string; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        contentType: req.headers['content-type'] ?? '',
        authorization: req.headers.authorization ?? '',
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const telemetry = startTelemetry({
    spans: new InMemorySpanExporter(),
    logs: new InMemoryLogRecordExporter(),
    metrics: new OTLPMetricExporter({
      url: `http://127.0.0.1:${port}/v1/metrics`,
      headers: { Authorization: 'Bearer test' },
    }),
  })!;
  try {
    const app = new Hono();
    app.use(requestTelemetry);
    app.get('/api/notifications/:id', (c) => c.json({ ok: true }));
    await app.request('/api/notifications/private-id?token=private-token');
    recordMessageStarted('notifications-api');
    recordMessageFinished('notifications-api', 'ack', 0.02);
    recordEmailResult('verification', 'sent');
    await telemetry.meterProvider.forceFlush();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      contentType: 'application/x-protobuf',
      authorization: 'Bearer test',
    });
    for (const value of [
      'http.server.request.duration',
      'udesa.messaging.consumed',
      'udesa.messaging.processing.duration',
      'udesa.email.sent',
      'service.instance.id',
      '/api/notifications/:id',
    ]) {
      expect(received[0].body.includes(Buffer.from(value))).toBe(true);
    }
    expect(received[0].body.includes(Buffer.from('private-id'))).toBe(false);
    expect(received[0].body.includes(Buffer.from('private-token'))).toBe(false);
  } finally {
    await Promise.all([
      telemetry.meterProvider.shutdown(),
      telemetry.tracerProvider.shutdown(),
      telemetry.loggerProvider.shutdown(),
    ]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
