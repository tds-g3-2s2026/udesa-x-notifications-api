import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDeviceTokenStore,
  deviceTokenCollection,
} from '../../src/infrastructure/device-token-store';
import { createMongoClient } from '../../src/infrastructure/mongodb';

// Against a real MongoDB: the upsert and the unique `_id` are what keep one
// owner per device, and only the database can prove them.
const { MONGODB_URL } = process.env;
if (!MONGODB_URL) {
  throw new Error('tests/integration needs MONGODB_URL');
}

let mongo: MongoClient;
const created: string[] = [];

const tokens = () => deviceTokenCollection(mongo);

function newToken(): string {
  const token = `fcm-${randomUUID()}`;
  created.push(token);
  return token;
}

beforeAll(() => {
  mongo = createMongoClient(MONGODB_URL);
});

afterAll(async () => {
  await tokens().deleteMany({ _id: { $in: created } });
  await mongo.close();
});

describe('device token store', () => {
  it('stores a new token under its account', async () => {
    const store = createDeviceTokenStore(tokens());
    const token = newToken();
    const account = randomUUID();
    const at = new Date('2026-10-25T12:00:00Z');

    await store.register(token, account, at);

    expect(await tokens().findOne({ _id: token })).toEqual({
      _id: token,
      account_id: account,
      updated_at: at,
    });
  });

  it('E4-H1.CA3 el token se actualiza en cada login', async () => {
    const store = createDeviceTokenStore(tokens());
    const token = newToken();
    const account = randomUUID();

    await store.register(token, account, new Date('2026-10-25T12:00:00Z'));
    await store.register(token, account, new Date('2026-10-26T09:30:00Z'));

    expect(await tokens().find({ _id: token }).toArray()).toEqual([
      { _id: token, account_id: account, updated_at: new Date('2026-10-26T09:30:00Z') },
    ]);
  });

  it('moves the token to whoever signs in on that device next', async () => {
    const store = createDeviceTokenStore(tokens());
    const token = newToken();
    const [first, second] = [randomUUID(), randomUUID()];

    await store.register(token, first, new Date('2026-10-25T12:00:00Z'));
    await store.register(token, second, new Date('2026-10-25T12:05:00Z'));

    expect(await tokens().countDocuments({ _id: token })).toBe(1);
    expect((await tokens().findOne({ _id: token }))?.account_id).toBe(second);
  });
});
