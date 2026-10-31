import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';

import { EVENT_TYPES, type HandlerResult } from '../app/events';
import { logEvent } from './telemetry';

// The contract with users-api (platform ADR-017): it declares the exchange with
// the same arguments, we own the queue and its dead-letter side.
export const EVENTS_EXCHANGE = 'udesa-x.events';
export const DEAD_LETTER_EXCHANGE = 'udesa-x.events.dlx';
export const QUEUE = 'notifications-api';
export const DEAD_LETTER_QUEUE = 'notifications-api.dlq';

// Messages the service holds unacked at once. Enough to overlap a few sends,
// small enough that a slow provider does not pull the whole queue into memory.
const PREFETCH = 10;

/** Declares what the service needs on the broker. Idempotent, so it runs on every connect. */
export async function declareTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', { durable: true });
  await channel.assertQueue(DEAD_LETTER_QUEUE, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');
  await channel.assertQueue(QUEUE, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE },
  });
  for (const type of EVENT_TYPES) {
    await channel.bindQueue(QUEUE, EVENTS_EXCHANGE, type);
  }
}

/**
 * Consumes the events queue with manual acks.
 *
 * `setup` is meant for amqplib's recovery hook: it runs after every
 * (re)connection with the new connection, so the topology and the consumer
 * come back by themselves after an outage. A channel the broker closes while
 * the connection stays up (a failed declaration, a cancelled consumer) would
 * leave the service connected and deaf, so in that case the connection is
 * closed to make recovery run `setup` again.
 */
export function createEventConsumer(handle: (body: string) => Promise<HandlerResult>) {
  const inFlight = new Set<Promise<void>>();
  let active: { channel: Channel; consumerTag: string } | undefined;
  let stopping = false;

  function settle(action: () => void, msg: ConsumeMessage): void {
    try {
      action();
    } catch (error) {
      // The channel went away while the message was being handled. The broker
      // redelivers it and the handler drops it as a duplicate.
      logEvent('warn', 'Could not settle a message, it will be redelivered', {
        messageId: msg.properties.messageId ?? '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleMessage(channel: Channel, msg: ConsumeMessage): Promise<void> {
    let result: HandlerResult;
    try {
      result = await handle(msg.content.toString('utf8'));
    } catch (error) {
      // MongoDB or another dependency failed: give the message back.
      logEvent('error', 'Event handling failed, requeueing', {
        messageId: msg.properties.messageId ?? '',
        error: error instanceof Error ? error.message : String(error),
      });
      settle(() => channel.nack(msg, false, true), msg);
      return;
    }
    settle(() => (result === 'ack' ? channel.ack(msg) : channel.nack(msg, false, false)), msg);
  }

  async function setup(model: ChannelModel): Promise<void> {
    const channel = await model.createChannel();
    const restart = (reason: string) => {
      if (stopping) {
        return;
      }
      logEvent('warn', 'Events channel lost, reconnecting', { reason });
      model.close().catch(() => {});
    };
    // An 'error' with no listener would throw. The 'close' that follows it is
    // where the consumer is restarted.
    channel.on('error', (error: Error) => {
      logEvent('warn', 'Events channel error', { error: error.message });
    });
    channel.on('close', () => restart('channel closed'));

    await declareTopology(channel);
    await channel.prefetch(PREFETCH);
    const { consumerTag } = await channel.consume(QUEUE, (msg) => {
      if (msg === null) {
        restart('consumer cancelled by the broker');
        return;
      }
      const work: Promise<void> = handleMessage(channel, msg).finally(() => inFlight.delete(work));
      inFlight.add(work);
    });
    active = { channel, consumerTag };
    logEvent('info', 'Consuming events', { queue: QUEUE });
  }

  /** Stops taking messages and waits for the ones being handled. Call before closing the connection. */
  async function drain(): Promise<void> {
    stopping = true;
    if (active) {
      await active.channel.cancel(active.consumerTag).catch(() => {});
    }
    await Promise.allSettled(inFlight);
  }

  return { setup, drain };
}
