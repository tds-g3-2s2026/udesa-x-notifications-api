import { EventEmitter } from 'node:events';

import type { ChannelModel, ConsumeMessage } from 'amqplib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEventConsumer } from '../../src/infrastructure/event-consumer';

// Stands in for an amqplib channel. The real one is exercised in tests/integration.
function fakeChannel() {
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: vi.fn(async () => ({})),
    assertQueue: vi.fn(async () => ({})),
    bindQueue: vi.fn(async () => ({})),
    prefetch: vi.fn(async () => ({})),
    consume: vi.fn<
      (
        queue: string,
        onMessage: (msg: ConsumeMessage | null) => void
      ) => Promise<{ consumerTag: string }>
    >(async () => ({ consumerTag: 'tag-1' })),
    cancel: vi.fn(async () => ({})),
    ack: vi.fn(),
    nack: vi.fn(),
  });
  return channel;
}

function fakeModel(channel = fakeChannel()) {
  const model = { createChannel: vi.fn(async () => channel), close: vi.fn(async () => {}) };
  return { model, channel, asModel: () => model as unknown as ChannelModel };
}

function message(body: string): ConsumeMessage {
  return { content: Buffer.from(body), properties: { messageId: 'm-1' } } as ConsumeMessage;
}

async function deliver(channel: ReturnType<typeof fakeChannel>, msg: ConsumeMessage | null) {
  channel.consume.mock.calls[0][1](msg);
  // Let the handler and the ack run.
  await vi.waitFor(() =>
    expect(channel.ack.mock.calls.length + channel.nack.mock.calls.length).toBe(1)
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('event consumer setup', () => {
  it('declares the exchange, the DLX, the DLQ and the quorum queue with its four bindings', async () => {
    const { channel, asModel } = fakeModel();

    await createEventConsumer(async () => 'ack').setup(asModel());

    expect(channel.assertExchange.mock.calls).toEqual([
      ['udesa-x.events', 'topic', { durable: true }],
      ['udesa-x.events.dlx', 'fanout', { durable: true }],
    ]);
    expect(channel.assertQueue.mock.calls).toEqual([
      ['notifications-api.dlq', { durable: true, arguments: { 'x-queue-type': 'quorum' } }],
      [
        'notifications-api',
        {
          durable: true,
          arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'udesa-x.events.dlx' },
        },
      ],
    ]);
    expect(channel.bindQueue.mock.calls).toEqual([
      ['notifications-api.dlq', 'udesa-x.events.dlx', ''],
      ['notifications-api', 'udesa-x.events', 'user.registered.v1'],
      ['notifications-api', 'udesa-x.events', 'email_verification.requested.v1'],
      ['notifications-api', 'udesa-x.events', 'password.reset_requested.v1'],
      ['notifications-api', 'udesa-x.events', 'password.changed.v1'],
    ]);
  });

  it('limits the unacked messages and consumes with manual acks', async () => {
    const { channel, asModel } = fakeModel();

    await createEventConsumer(async () => 'ack').setup(asModel());

    expect(channel.prefetch).toHaveBeenCalledWith(10);
    expect(channel.consume).toHaveBeenCalledOnce();
    expect(channel.consume.mock.calls[0][0]).toBe('notifications-api');
    expect(channel.consume.mock.calls[0]).toHaveLength(2);
  });

  it('declares everything again on each connection', async () => {
    const consumer = createEventConsumer(async () => 'ack');
    const first = fakeModel();
    const second = fakeModel();

    await consumer.setup(first.asModel());
    await consumer.setup(second.asModel());

    expect(second.channel.assertQueue).toHaveBeenCalledTimes(2);
    expect(second.channel.consume).toHaveBeenCalledOnce();
  });

  it('fails the setup, so recovery retries, when the declaration fails', async () => {
    const { channel, asModel } = fakeModel();
    channel.assertQueue.mockRejectedValueOnce(new Error('PRECONDITION_FAILED'));

    await expect(createEventConsumer(async () => 'ack').setup(asModel())).rejects.toThrow(
      'PRECONDITION_FAILED'
    );
    expect(channel.consume).not.toHaveBeenCalled();
  });
});

describe('event consumer messages', () => {
  it('acks what the handler handled, passing it the body as text', async () => {
    const handle = vi.fn(async () => 'ack' as const);
    const { channel, asModel } = fakeModel();
    await createEventConsumer(handle).setup(asModel());
    const msg = message('{"id":"1"}');

    await deliver(channel, msg);

    expect(handle).toHaveBeenCalledWith('{"id":"1"}');
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('rejects without requeue what can never be handled, so it goes to the DLQ', async () => {
    const { channel, asModel } = fakeModel();
    await createEventConsumer(async () => 'dead-letter').setup(asModel());
    const msg = message('nope');

    await deliver(channel, msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('requeues when the handler throws', async () => {
    const { channel, asModel } = fakeModel();
    await createEventConsumer(async () => {
      throw new Error('MongoDB is down');
    }).setup(asModel());
    const msg = message('{}');

    await deliver(channel, msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });

  it('survives a channel that closed before the ack', async () => {
    const { channel, asModel } = fakeModel();
    channel.ack.mockImplementation(() => {
      throw new Error('Channel closed');
    });
    await createEventConsumer(async () => 'ack').setup(asModel());

    channel.consume.mock.calls[0][1](message('{}'));

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
  });
});

describe('event consumer recovery', () => {
  it('closes the connection when the broker closes the channel, so recovery sets up again', async () => {
    const { model, channel, asModel } = fakeModel();
    await createEventConsumer(async () => 'ack').setup(asModel());

    channel.emit('error', new Error('PRECONDITION_FAILED'));
    channel.emit('close');

    expect(model.close).toHaveBeenCalledOnce();
  });

  it('closes the connection when the broker cancels the consumer', async () => {
    const { model, channel, asModel } = fakeModel();
    await createEventConsumer(async () => 'ack').setup(asModel());

    channel.consume.mock.calls[0][1](null);

    expect(model.close).toHaveBeenCalledOnce();
  });
});

describe('event consumer drain', () => {
  it('cancels the consumer and waits for the message being handled', async () => {
    let finish!: () => void;
    const handle = vi.fn(() => new Promise<'ack'>((resolve) => (finish = () => resolve('ack'))));
    const { model, channel, asModel } = fakeModel();
    const consumer = createEventConsumer(handle);
    await consumer.setup(asModel());
    const msg = message('{}');
    channel.consume.mock.calls[0][1](msg);

    let drained = false;
    const draining = consumer.drain().then(() => (drained = true));
    await vi.waitFor(() => expect(channel.cancel).toHaveBeenCalledWith('tag-1'));
    expect(drained).toBe(false);

    finish();
    await draining;

    expect(channel.ack).toHaveBeenCalledWith(msg);
    // The channel closing afterwards is the shutdown, not a loss to recover from.
    channel.emit('close');
    expect(model.close).not.toHaveBeenCalled();
  });
});
