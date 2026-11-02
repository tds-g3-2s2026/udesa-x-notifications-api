import { EventEmitter } from 'node:events';

import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ChannelModel, ConsumeMessage } from 'amqplib';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailStore } from '../../src/app/email-events';
import { createEmailEventHandler } from '../../src/app/email-events';
import type { HandlerResult } from '../../src/app/events';
import { createEventConsumer } from '../../src/infrastructure/event-consumer';
import {
  requestTelemetry,
  startTelemetry,
  type Telemetry,
} from '../../src/infrastructure/telemetry';
import { exampleEvent } from '../support/contracts';

const records = new InMemoryMetricExporter(AggregationTemporality.DELTA);
let telemetry: Telemetry;

beforeAll(() => {
  telemetry = startTelemetry({
    spans: new InMemorySpanExporter(),
    logs: new InMemoryLogRecordExporter(),
    metrics: records,
  })!;
});

beforeEach(async () => {
  await telemetry.meterProvider.forceFlush();
  records.reset();
  vi.restoreAllMocks();
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterAll(async () => {
  await Promise.all([
    telemetry.tracerProvider.shutdown(),
    telemetry.loggerProvider.shutdown(),
    telemetry.meterProvider.shutdown(),
  ]);
});

async function metrics(): Promise<MetricData[]> {
  await telemetry.meterProvider.forceFlush();
  return records
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics.flatMap((s) => s.metrics));
}

function queue(handle: (body: string) => Promise<HandlerResult>) {
  let receive!: (message: ConsumeMessage | null) => void;
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: vi.fn(async () => ({})),
    assertQueue: vi.fn(async () => ({})),
    bindQueue: vi.fn(async () => ({})),
    prefetch: vi.fn(async () => ({})),
    consume: vi.fn(async (_queue: string, callback: typeof receive) => {
      receive = callback;
      return { consumerTag: 'metrics-consumer' };
    }),
    ack: vi.fn(),
    nack: vi.fn(),
    cancel: vi.fn(async () => {}),
  });
  const consumer = createEventConsumer(handle);
  return {
    channel,
    async deliver(body: string) {
      await consumer.setup({ createChannel: async () => channel } as unknown as ChannelModel);
      receive({
        content: Buffer.from(body),
        properties: { messageId: 'private-event-id' },
      } as ConsumeMessage);
      await consumer.drain();
    },
  };
}

describe('HTTP metrics', () => {
  function app() {
    const result = new Hono();
    result.use(requestTelemetry);
    result.get('/api/notifications/:id', (c) => c.json({ ok: true }));
    result.get('/healthcheck', (c) => c.json({ status: 'ok' }));
    result.get('/livez', (c) => c.json({ status: 'ok' }));
    return result;
  }

  it('records a template route and duration in seconds without IDs or query strings', async () => {
    await app().request('/api/notifications/private-id?token=private-token');
    const histogram = (await metrics()).find(
      (m) => m.descriptor.name === 'http.server.request.duration'
    );
    expect(histogram?.descriptor.unit).toBe('s');
    expect(histogram?.dataPoints[0].attributes).toEqual({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'http.route': '/api/notifications/:id',
    });
    expect(histogram?.dataPoints[0].value).toMatchObject({ count: 1 });
    expect(JSON.stringify(histogram)).not.toMatch(/private-id|private-token/);
    expect(records.getMetrics()[0].resource.attributes).toMatchObject({
      'service.name': 'notifications-api',
      'service.instance.id': expect.any(String),
    });
  });

  it('does not record probes, including probes with query strings', async () => {
    const service = app();
    await service.request('/healthcheck?token=private');
    await service.request('/livez');
    expect(await metrics()).toEqual([]);
  });

  it('does not use an unmatched raw path as a metric attribute', async () => {
    await app().request('/unknown/private-id');
    const histogram = (await metrics()).find(
      (m) => m.descriptor.name === 'http.server.request.duration'
    );
    expect(histogram?.dataPoints[0].attributes).toEqual({
      'http.request.method': 'GET',
      'http.response.status_code': 404,
    });
  });

  it('records the final status from a custom error handler', async () => {
    const service = app();
    service.get('/broken', () => {
      throw new Error('invalid');
    });
    service.onError((_error, c) => c.json({ error: 'invalid' }, 422));
    expect((await service.request('/broken')).status).toBe(422);
    const histogram = (await metrics()).find(
      (m) => m.descriptor.name === 'http.server.request.duration'
    );
    expect(histogram?.dataPoints[0].attributes['http.response.status_code']).toBe(422);
  });
});

describe('message processing metrics', () => {
  it.each([
    ['ack', undefined],
    ['dead-letter', 'udesa.messaging.dead_letter'],
    ['failed', 'udesa.messaging.failed'],
  ] as const)(
    'counts one %s attempt with processing duration and only the queue label',
    async (outcome, counter) => {
      const consumer = queue(async () => {
        if (outcome === 'failed') throw new Error('store down');
        return outcome;
      });
      await consumer.deliver('private-payload');
      const values = await metrics();
      expect(
        values.find((m) => m.descriptor.name === 'udesa.messaging.consumed')?.dataPoints
      ).toEqual([
        expect.objectContaining({
          attributes: { 'messaging.destination.name': 'notifications-api' },
          value: 1,
        }),
      ]);
      if (counter)
        expect(values.find((m) => m.descriptor.name === counter)?.dataPoints[0].value).toBe(1);
      const duration = values.find(
        (m) => m.descriptor.name === 'udesa.messaging.processing.duration'
      );
      expect(duration?.descriptor.unit).toBe('s');
      expect(duration?.dataPoints[0].value).toMatchObject({ count: 1 });
      expect(JSON.stringify(values)).not.toMatch(/private-payload|private-event-id/);
      if (outcome === 'ack') expect(consumer.channel.ack).toHaveBeenCalledOnce();
      else
        expect(consumer.channel.nack).toHaveBeenCalledWith(
          expect.anything(),
          false,
          outcome === 'failed'
        );
    }
  );
});

describe('email metrics', () => {
  it.each([
    ['user.registered.v1', 'verification'],
    ['email_verification.requested.v1', 'verification'],
    ['password.reset_requested.v1', 'password_reset'],
    ['password.changed.v1', 'password_changed'],
  ])('counts an actual %s send once when a duplicate is discarded', async (type, template) => {
    let delivered = false;
    const store: EmailStore = {
      insertPending: async () => (delivered ? 'sent' : null),
      finish: async () => {
        delivered = true;
      },
    };
    const sender = { send: vi.fn(async () => {}) };
    const handle = createEmailEventHandler({ store, sender });
    const body = JSON.stringify(exampleEvent(type));
    await handle(body);
    await handle(body);
    const sent = (await metrics()).find((m) => m.descriptor.name === 'udesa.email.sent');
    expect(sent?.dataPoints).toEqual([
      expect.objectContaining({ attributes: { template }, value: 1 }),
    ]);
    expect(sender.send).toHaveBeenCalledOnce();
  });

  it('counts a rejected send as failed even though processing is acknowledged', async () => {
    const handle = createEmailEventHandler({
      store: { insertPending: async () => null, finish: async () => {} },
      sender: {
        send: async () => {
          throw new Error('provider down');
        },
      },
    });
    expect(await handle(JSON.stringify(exampleEvent('password.changed.v1')))).toBe('ack');
    const values = await metrics();
    expect(
      values.find((m) => m.descriptor.name === 'udesa.email.failed')?.dataPoints[0]
    ).toMatchObject({
      attributes: { template: 'password_changed' },
      value: 1,
    });
    expect(values.find((m) => m.descriptor.name === 'udesa.email.sent')).toBeUndefined();
  });

  it('counts provider success even if saving its result fails afterwards', async () => {
    const handle = createEmailEventHandler({
      store: {
        insertPending: async () => null,
        finish: async () => {
          throw new Error('store down');
        },
      },
      sender: { send: async () => {} },
    });
    await expect(handle(JSON.stringify(exampleEvent('password.changed.v1')))).rejects.toThrow(
      'store down'
    );
    const values = await metrics();
    expect(values.find((m) => m.descriptor.name === 'udesa.email.sent')?.dataPoints[0].value).toBe(
      1
    );
    expect(values.find((m) => m.descriptor.name === 'udesa.email.failed')).toBeUndefined();
  });
});
