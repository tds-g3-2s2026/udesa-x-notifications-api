import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMongoClient } from '../../src/infrastructure/mongodb';
import {
  createNotificationStore,
  notificationCollection,
} from '../../src/infrastructure/notification-store';
import { buildApp, requestAs } from '../support/app';
import { aNotification } from '../support/notifications';

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

async function seed(account: string, count: number): Promise<string[]> {
  const store = createNotificationStore(notifications());
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const notification = aNotification(account);
    await store.add(notification);
    ids.push(notification.id);
  }
  return ids;
}

const readAll = (account: string) =>
  requestAs(
    buildApp({ notifications: createNotificationStore(notifications()) }),
    account,
    '/api/notifications/read-all',
    'POST'
  );

beforeAll(() => {
  mongo = createMongoClient(MONGODB_URL);
});

afterAll(async () => {
  await notifications().deleteMany({ recipient_id: { $in: accounts } });
  await mongo.close();
});

describe('POST /api/notifications/read-all against MongoDB', () => {
  it('E4-H3.CA2 marca todas como leídas', async () => {
    const account = newAccount();
    await seed(account, 3);

    const res = await readAll(account);

    expect(res.status).toBe(204);
    const stored = await notifications().find({ recipient_id: account }).toArray();
    expect(stored).toHaveLength(3);
    for (const notification of stored) {
      expect(notification.read_at).toBeInstanceOf(Date);
    }
  });

  it('keeps the date a notification was first read', async () => {
    const account = newAccount();
    const [alreadyRead] = await seed(account, 2);
    const firstRead = new Date('2026-10-20T10:00:00.000Z');
    await notifications().updateOne({ _id: alreadyRead }, { $set: { read_at: firstRead } });

    await readAll(account);

    expect((await notifications().findOne({ _id: alreadyRead }))?.read_at).toEqual(firstRead);
  });

  it('touches nothing of another account', async () => {
    const account = newAccount();
    const other = newAccount();
    await seed(other, 2);

    await readAll(account);

    expect(await notifications().countDocuments({ recipient_id: other, read_at: null })).toBe(2);
  });
});
