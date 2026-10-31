import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Notification } from '../../src/app/notifications';
import { createMongoClient } from '../../src/infrastructure/mongodb';
import {
  createNotificationStore,
  ensureNotificationIndexes,
  notificationCollection,
  pageQuery,
} from '../../src/infrastructure/notification-store';
import { buildApp, requestAs } from '../support/app';
import { aNotification } from '../support/notifications';

// The whole listing against a real MongoDB: the order, the cursor and the
// index are what MongoDB does with the query, so only MongoDB can prove them.
const { MONGODB_URL } = process.env;
if (!MONGODB_URL) {
  throw new Error('tests/integration needs MONGODB_URL');
}

let mongo: MongoClient;
const accounts: string[] = [];

const notifications = () => notificationCollection(mongo);

function newAccount(): string {
  const account = randomUUID();
  accounts.push(account);
  return account;
}

/** `count` notifications one second apart, the first one the oldest. */
async function seed(account: string, count: number): Promise<Omit<Notification, 'readAt'>[]> {
  const store = createNotificationStore(notifications());
  const seeded = Array.from({ length: count }, (_, i) =>
    aNotification(account, { createdAt: new Date(Date.UTC(2026, 9, 23, 12, 0, i)) })
  );
  for (const notification of seeded) {
    await store.add(notification);
  }
  return seeded;
}

async function list(account: string, cursor?: string) {
  const res = await requestAs(
    buildApp({ notifications: createNotificationStore(notifications()) }),
    account,
    `/api/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    items: { id: string; readAt: string | null; createdAt: string }[];
    nextCursor: string | null;
  };
}

beforeAll(async () => {
  mongo = createMongoClient(MONGODB_URL);
  await ensureNotificationIndexes(notifications());
});

afterAll(async () => {
  await notifications().deleteMany({ recipient_id: { $in: accounts } });
  await mongo.close();
});

describe('GET /api/notifications against MongoDB', () => {
  it('E4-H3.CA3 20 por página en orden descendente', async () => {
    const account = newAccount();
    const newestFirst = (await seed(account, 25)).reverse().map((n) => n.id);

    const first = await list(account);
    const second = await list(account, first.nextCursor!);

    expect(first.items.map((item) => item.id)).toEqual(newestFirst.slice(0, 20));
    expect(first.nextCursor).not.toBeNull();
    expect(second.items.map((item) => item.id)).toEqual(newestFirst.slice(20));
    expect(second.nextCursor).toBeNull();
  });

  it('E4-H3.CA1 el listado indica las no leídas', async () => {
    const account = newAccount();
    const [older, newer] = await seed(account, 2);
    const readAt = new Date('2026-10-24T09:00:00.000Z');
    await notifications().updateOne({ _id: older.id }, { $set: { read_at: readAt } });

    const { items } = await list(account);

    expect(items).toEqual([
      expect.objectContaining({ id: newer.id, readAt: null }),
      expect.objectContaining({ id: older.id, readAt: readAt.toISOString() }),
    ]);
  });

  it('breaks ties on the same instant by id, so a page boundary repeats or skips nothing', async () => {
    const account = newAccount();
    const store = createNotificationStore(notifications());
    const createdAt = new Date('2026-10-23T12:00:00.000Z');
    const ids = Array.from({ length: 30 }, () => randomUUID());
    for (const id of ids) {
      await store.add(aNotification(account, { id, createdAt }));
    }

    const first = await list(account);
    const second = await list(account, first.nextCursor!);

    const listed = [...first.items, ...second.items].map((item) => item.id);
    expect(listed).toEqual([...ids].sort().reverse());
  });

  it('lists only the notifications of the account in the token', async () => {
    const account = newAccount();
    await seed(newAccount(), 3);

    expect(await list(account)).toEqual({ items: [], nextCursor: null });
  });

  it('leaves out the deleted ones', async () => {
    const account = newAccount();
    const [deleted, kept] = await seed(account, 2);
    await notifications().updateOne({ _id: deleted.id }, { $set: { deleted_at: new Date() } });

    const { items } = await list(account);

    expect(items.map((item) => item.id)).toEqual([kept.id]);
  });
});

describe('notification store', () => {
  it('keeps the first copy when the same event adds a notification twice', async () => {
    const account = newAccount();
    const store = createNotificationStore(notifications());
    const notification = aNotification(account);

    await store.add(notification);
    await store.add({ ...notification, type: 'retweet' });

    expect(await notifications().countDocuments({ _id: notification.id })).toBe(1);
    expect(await notifications().findOne({ _id: notification.id })).toEqual({
      _id: notification.id,
      recipient_id: account,
      type: 'like',
      actor_id: notification.actor.id,
      actor_handle: 'juanperez',
      post_id: notification.postId,
      reply_id: null,
      created_at: notification.createdAt,
      read_at: null,
      deleted_at: null,
    });
  });

  it('serves a page from the index, without scanning the collection', async () => {
    const { filter, sort } = pageQuery(randomUUID(), {
      createdAt: new Date('2026-10-23T12:00:00.000Z'),
      id: randomUUID(),
    });

    const plan = await notifications().find(filter).sort(sort).limit(21).explain();

    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winning).toContain('recipient_id_1_deleted_at_1_created_at_-1__id_-1');
    expect(winning).not.toContain('COLLSCAN');
    expect(winning).not.toContain('"SORT"');
  });
});
