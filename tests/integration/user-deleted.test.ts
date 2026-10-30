import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUserDeletedHandler } from '../../src/app/user-deletion';
import {
  createDeviceTokenStore,
  deviceTokenCollection,
} from '../../src/infrastructure/device-token-store';
import { createMongoClient } from '../../src/infrastructure/mongodb';
import {
  createNotificationStore,
  notificationCollection,
} from '../../src/infrastructure/notification-store';
import {
  createProcessedEventStore,
  processedEventCollection,
} from '../../src/infrastructure/processed-event-store';
import { exampleEvent, type EventEnvelope } from '../support/contracts';
import { aNotification } from '../support/notifications';

// The handler with the real stores. That the queue gets the event from the
// exchange is in email-consumer.test.ts, which owns the queue in this suite.
const { MONGODB_URL } = process.env;
if (!MONGODB_URL) {
  throw new Error('tests/integration needs MONGODB_URL');
}

let mongo: MongoClient;
const accounts: string[] = [];
const eventIds: string[] = [];
const tokenIds: string[] = [];

const tokens = () => deviceTokenCollection(mongo);
const notifications = () => notificationCollection(mongo);
const processed = () => processedEventCollection(mongo);

function handler() {
  return createUserDeletedHandler({
    deviceTokens: createDeviceTokenStore(tokens()),
    notifications: createNotificationStore(notifications()),
    processedEvents: createProcessedEventStore(processed()),
  });
}

function newAccount(): string {
  const account = randomUUID();
  accounts.push(account);
  return account;
}

function deletionOf(account: string): EventEnvelope {
  const id = randomUUID();
  eventIds.push(id);
  const event = exampleEvent('user.deleted.v1', id);
  event.data.user_id = account;
  return event;
}

/** A device token and two notifications for the account. */
async function seed(account: string) {
  const token = `fcm-${randomUUID()}`;
  tokenIds.push(token);
  await createDeviceTokenStore(tokens()).register(token, account, new Date());
  const store = createNotificationStore(notifications());
  const ids = [aNotification(account), aNotification(account)];
  for (const notification of ids) {
    await store.add(notification);
  }
  return { token, notificationIds: ids.map((n) => n.id) };
}

beforeAll(() => {
  mongo = createMongoClient(MONGODB_URL);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterAll(async () => {
  await Promise.all([
    tokens().deleteMany({ _id: { $in: tokenIds } }),
    notifications().deleteMany({ recipient_id: { $in: accounts } }),
    processed().deleteMany({ _id: { $in: eventIds } }),
  ]);
  await mongo.close();
});

describe('user.deleted against MongoDB', () => {
  it('E4-H3.CA5 user.deleted borra tokens y notificaciones del usuario', async () => {
    const account = newAccount();
    const { token, notificationIds } = await seed(account);
    const event = deletionOf(account);

    await expect(handler()(JSON.stringify(event))).resolves.toBe('ack');

    // Logical: every document is still there, marked with the time of the deletion.
    const at = new Date(event.time);
    expect(await tokens().findOne({ _id: token })).toMatchObject({ deleted_at: at });
    const stored = await notifications().find({ recipient_id: account }).toArray();
    expect(stored.map((n) => n._id).sort()).toEqual([...notificationIds].sort());
    for (const notification of stored) {
      expect(notification.deleted_at).toEqual(at);
    }
  });

  it('touches nothing of other accounts', async () => {
    const account = newAccount();
    const other = newAccount();
    await seed(account);
    const { token } = await seed(other);

    await handler()(JSON.stringify(deletionOf(account)));

    expect((await tokens().findOne({ _id: token }))?.deleted_at).toBeNull();
    expect(await notifications().countDocuments({ recipient_id: other, deleted_at: null })).toBe(2);
  });

  it('records the event, and drops it when it arrives again', async () => {
    const account = newAccount();
    await seed(account);
    const event = deletionOf(account);
    await handler()(JSON.stringify(event));

    await expect(handler()(JSON.stringify(event))).resolves.toBe('ack');

    expect(await processed().findOne({ _id: event.id })).toMatchObject({
      type: 'user.deleted.v1',
      user_id: account,
      processed_at: expect.any(Date),
    });
    expect(await processed().countDocuments({ _id: event.id })).toBe(1);
    expect(console.info).toHaveBeenCalledWith('Duplicate event dropped', {
      id: event.id,
      type: 'user.deleted.v1',
    });
  });

  it('finishes the job when a retry finds it half done, keeping the first date', async () => {
    const account = newAccount();
    const { token } = await seed(account);
    const event = deletionOf(account);
    // As if the first attempt died after the tokens and before the notifications.
    const earlier = new Date('2026-10-01T00:00:00.000Z');
    await createDeviceTokenStore(tokens()).softDeleteOwnedBy(account, earlier);

    await handler()(JSON.stringify(event));

    expect((await tokens().findOne({ _id: token }))?.deleted_at).toEqual(earlier);
    expect(await notifications().countDocuments({ recipient_id: account, deleted_at: null })).toBe(
      0
    );
    expect(await processed().countDocuments({ _id: event.id })).toBe(1);
  });
});
