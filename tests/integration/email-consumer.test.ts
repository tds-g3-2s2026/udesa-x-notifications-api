import { randomUUID } from 'node:crypto';

import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type GetMessage,
} from 'amqplib';
import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailMessage, EmailSender } from '../../src/app/email';
import { createEmailEventHandler, EMAIL_EVENT_TYPES } from '../../src/app/email-events';
import { routeEvents } from '../../src/app/events';
import { createFollowCreatedHandler } from '../../src/app/follows';
import type { PushSender } from '../../src/app/push';
import { createUserDeletedHandler } from '../../src/app/user-deletion';
import {
  createDeviceTokenStore,
  deviceTokenCollection,
} from '../../src/infrastructure/device-token-store';
import { createEmailStore, emailCollection } from '../../src/infrastructure/email-store';
import {
  createEventConsumer,
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE,
  EVENTS_EXCHANGE,
  QUEUE,
} from '../../src/infrastructure/event-consumer';
import { createMongoClient } from '../../src/infrastructure/mongodb';
import {
  createNotificationStore,
  notificationCollection,
} from '../../src/infrastructure/notification-store';
import {
  createProcessedEventStore,
  processedEventCollection,
} from '../../src/infrastructure/processed-event-store';
import { connectRabbitMQ, type RabbitMQ } from '../../src/infrastructure/rabbitmq';
import { exampleEvent, type EventEnvelope } from '../support/contracts';
import { aNotification } from '../support/notifications';

// The whole flow against real RabbitMQ and MongoDB: a message published to the
// exchange, routed by its type to the service's queue, consumed, deduplicated
// and recorded. Only the email and push senders are doubles. It consumes the
// real queue name, so it cannot share a broker with a running notifications-api.
const { MONGODB_URL, RABBITMQ_URL } = process.env;
if (!MONGODB_URL || !RABBITMQ_URL) {
  throw new Error('tests/integration needs MONGODB_URL and RABBITMQ_URL');
}

const sent: EmailMessage[] = [];
const sender: EmailSender = {
  async send(message) {
    sent.push(message);
  },
};

/** The tokens of every push, in the order they went out. */
const pushed: string[][] = [];
const push: PushSender = {
  async send(tokens) {
    pushed.push(tokens);
    return { invalidTokens: [] };
  },
};

let mongo: MongoClient;
let consumerConnection: RabbitMQ;
let publisherConnection: ChannelModel;
let publisher: ConfirmChannel;
const returned: ConsumeMessage[] = [];
const createdIds: string[] = [];

const emails = () => emailCollection(mongo);
const notifications = () => notificationCollection(mongo);
const deletedAccounts: string[] = [];

function newEvent(type: string): EventEnvelope {
  const id = randomUUID();
  createdIds.push(id);
  return exampleEvent(type, id);
}

async function publish(routingKey: string, body: string, messageId?: string) {
  publisher.publish(EVENTS_EXCHANGE, routingKey, Buffer.from(body), {
    mandatory: true,
    persistent: true,
    contentType: 'application/json',
    messageId,
    type: routingKey,
  });
  await publisher.waitForConfirms();
}

const publishEvent = (event: EventEnvelope) => publish(event.type, JSON.stringify(event), event.id);

beforeAll(async () => {
  mongo = createMongoClient(MONGODB_URL);
  const deviceTokens = createDeviceTokenStore(deviceTokenCollection(mongo));
  const handler = routeEvents({
    email: createEmailEventHandler({ store: createEmailStore(emails()), sender }),
    userDeleted: createUserDeletedHandler({
      deviceTokens,
      notifications: createNotificationStore(notifications()),
      processedEvents: createProcessedEventStore(processedEventCollection(mongo)),
    }),
    followCreated: createFollowCreatedHandler({
      notifications: createNotificationStore(notifications()),
      deviceTokens,
      push,
    }),
  });
  consumerConnection = await connectRabbitMQ(RABBITMQ_URL, createEventConsumer(handler).setup);
  await vi.waitFor(() => consumerConnection.check(), { timeout: 15_000, interval: 100 });

  publisherConnection = await connect(RABBITMQ_URL);
  publisher = await publisherConnection.createConfirmChannel();
  publisher.on('return', (msg: ConsumeMessage) => returned.push(msg));
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  sent.length = 0;
  pushed.length = 0;
  returned.length = 0;
});

afterAll(async () => {
  await emails().deleteMany({ _id: { $in: createdIds } });
  await notifications().deleteMany({ recipient_id: { $in: deletedAccounts } });
  await processedEventCollection(mongo).deleteMany({ _id: { $in: createdIds } });
  await deviceTokenCollection(mongo).deleteMany({ account_id: { $in: deletedAccounts } });
  await Promise.allSettled([
    consumerConnection.close(),
    publisherConnection.close(),
    mongo.close(),
  ]);
});

describe('events queue', () => {
  it('is a durable quorum queue that dead-letters to the DLX', async () => {
    // Declaring a queue again with different arguments is refused, so this
    // only succeeds if the service declared it exactly like this.
    const connection = await connect(RABBITMQ_URL);
    try {
      const channel = await connection.createChannel();
      const { consumerCount } = await channel.assertQueue(QUEUE, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE },
      });
      expect(consumerCount).toBeGreaterThanOrEqual(1);
      await channel.assertQueue(DEAD_LETTER_QUEUE, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum' },
      });
    } finally {
      await connection.close();
    }
  });

  it.each(EMAIL_EVENT_TYPES)('is bound to %s and mails the example of its schema', async (type) => {
    const event = newEvent(type);

    await publishEvent(event);

    // A mandatory message with no queue bound comes back as a return.
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000, interval: 50 });
    expect(returned).toHaveLength(0);
    expect(sent[0].to).toBe(event.data.email);
    await vi.waitFor(async () => {
      expect(await emails().findOne({ _id: event.id })).toMatchObject({ status: 'sent', type });
    });
  });
});

describe('user.deleted across the broker', () => {
  it('is bound to user.deleted.v1 and soft-deletes the notifications of the account', async () => {
    const account = randomUUID();
    deletedAccounts.push(account);
    const notification = aNotification(account);
    await createNotificationStore(notifications()).add(notification);
    const event = newEvent('user.deleted.v1');
    event.data.user_id = account;

    await publishEvent(event);

    await vi.waitFor(
      async () => {
        expect((await notifications().findOne({ _id: notification.id }))?.deleted_at).toEqual(
          new Date(event.time)
        );
      },
      { timeout: 10_000, interval: 50 }
    );
    expect(returned).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('follow.created across the broker', () => {
  it('is bound to follow.created.v1, adds the entry and pushes to the followed account', async () => {
    const account = randomUUID();
    deletedAccounts.push(account);
    const token = `fcm-${randomUUID()}`;
    await createDeviceTokenStore(deviceTokenCollection(mongo)).register(token, account, new Date());
    const event = newEvent('follow.created.v1');
    event.data.followee_id = account;

    await publishEvent(event);

    await vi.waitFor(() => expect(pushed).toEqual([[token]]), { timeout: 10_000, interval: 50 });
    expect(await notifications().findOne({ _id: event.id })).toMatchObject({
      recipient_id: account,
      type: 'follow',
    });
    expect(returned).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('idempotency across the broker', () => {
  it('sends one email and keeps one sent record when the same event is published twice', async () => {
    const event = newEvent('user.registered.v1');

    await publishEvent(event);
    await publishEvent(event);

    await vi.waitFor(
      () =>
        expect(console.info).toHaveBeenCalledWith(
          'Duplicate event dropped',
          expect.objectContaining({ id: event.id, status: 'sent' })
        ),
      { timeout: 10_000, interval: 50 }
    );
    expect(sent).toHaveLength(1);
    expect(await emails().countDocuments({ _id: event.id })).toBe(1);
    expect(await emails().findOne({ _id: event.id })).toMatchObject({
      type: 'user.registered.v1',
      user_id: event.data.user_id,
      to: event.data.email,
      status: 'sent',
      sent_at: expect.any(Date),
    });
  });

  it('never stores the link or the body', async () => {
    const event = newEvent('user.registered.v1');

    await publishEvent(event);

    await vi.waitFor(async () => {
      expect(await emails().findOne({ _id: event.id })).toMatchObject({ status: 'sent' });
    });
    const stored = JSON.stringify(await emails().findOne({ _id: event.id }));
    expect(stored).not.toContain(event.data.verification_url);
    expect(stored).not.toContain('Para terminar de crear tu cuenta');
  });

  it('sends again an email a crashed attempt left pending', async () => {
    const event = newEvent('password.changed.v1');
    await emails().insertOne({
      _id: event.id,
      type: event.type,
      user_id: event.data.user_id,
      to: event.data.email,
      status: 'pending',
      created_at: new Date(),
      sent_at: null,
    });

    await publishEvent(event);

    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000, interval: 50 });
    await vi.waitFor(async () => {
      expect(await emails().findOne({ _id: event.id })).toMatchObject({ status: 'sent' });
    });
  });
});

describe('dead-letter queue', () => {
  async function nextDeadLetter(messageId: string): Promise<GetMessage> {
    const channel = await publisherConnection.createChannel();
    try {
      let found: GetMessage | undefined;
      await vi.waitFor(
        async () => {
          const msg = await channel.get(DEAD_LETTER_QUEUE);
          if (msg) {
            channel.ack(msg);
            if (msg.properties.messageId === messageId) {
              found = msg;
            }
          }
          expect(found).toBeDefined();
        },
        { timeout: 10_000, interval: 100 }
      );
      return found!;
    } finally {
      await channel.close();
    }
  }

  it('receives a message that is not JSON, and mails nothing', async () => {
    const messageId = randomUUID();

    await publish('user.registered.v1', 'not json {', messageId);

    const dead = await nextDeadLetter(messageId);
    expect(dead.content.toString()).toBe('not json {');
    expect(sent).toHaveLength(0);
  });

  it('receives a message whose data lacks a required field', async () => {
    const event = newEvent('password.reset_requested.v1');
    const data = { ...event.data };
    delete data.token;

    await publish(event.type, JSON.stringify({ ...event, data }), event.id);

    const dead = await nextDeadLetter(event.id);
    expect(dead.fields.routingKey).toBe('password.reset_requested.v1');
    expect(sent).toHaveLength(0);
    expect(await emails().countDocuments({ _id: event.id })).toBe(0);
  });
});
