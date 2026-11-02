import { Hono } from 'hono';
import { expect, it } from 'vitest';

import {
  recordEmailResult,
  recordMessageFinished,
  recordMessageStarted,
  requestTelemetry,
  startTelemetry,
} from '../../src/infrastructure/telemetry';

it('serves requests and processes metric observations without an exporter', async () => {
  expect(startTelemetry()).toBeUndefined();
  const app = new Hono();
  app.use(requestTelemetry);
  app.get('/api/notifications/:id', (c) => c.json({ ok: true }));
  expect((await app.request('/api/notifications/one')).status).toBe(200);
  recordMessageStarted('notifications-api');
  recordMessageFinished('notifications-api', 'ack', 0.01);
  recordEmailResult('verification', 'sent');
});
