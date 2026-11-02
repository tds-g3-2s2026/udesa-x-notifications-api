import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activeTokensFilter,
  createDeviceTokenStore,
  deviceTokenCollection,
  ensureDeviceTokenIndexes,
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

beforeAll(async () => {
  mongo = createMongoClient(MONGODB_URL);
  await ensureDeviceTokenIndexes(tokens());
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
      deleted_at: null,
    });
  });

  it('E4-H1.CA3 el token se actualiza en cada login', async () => {
    const store = createDeviceTokenStore(tokens());
    const token = newToken();
    const account = randomUUID();

    await store.register(token, account, new Date('2026-10-25T12:00:00Z'));
    await store.register(token, account, new Date('2026-10-26T09:30:00Z'));

    expect(await tokens().find({ _id: token }).toArray()).toEqual([
      {
        _id: token,
        account_id: account,
        updated_at: new Date('2026-10-26T09:30:00Z'),
        deleted_at: null,
      },
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

  it('marks every token of an account deleted, keeping the documents and the first date', async () => {
    const store = createDeviceTokenStore(tokens());
    const [phone, tablet, other] = [newToken(), newToken(), newToken()];
    const [account, someoneElse] = [randomUUID(), randomUUID()];
    await store.register(phone, account, new Date('2026-10-25T12:00:00Z'));
    await store.register(tablet, account, new Date('2026-10-25T12:00:00Z'));
    await store.register(other, someoneElse, new Date('2026-10-25T12:00:00Z'));
    const first = new Date('2026-10-27T08:00:00Z');

    await store.softDeleteOwnedBy(account, first);
    await store.softDeleteOwnedBy(account, new Date('2026-10-28T08:00:00Z'));

    const stored = await tokens()
      .find({ _id: { $in: [phone, tablet, other] } })
      .toArray();
    expect(stored).toHaveLength(3);
    expect(stored.find((t) => t._id === phone)?.deleted_at).toEqual(first);
    expect(stored.find((t) => t._id === tablet)?.deleted_at).toEqual(first);
    expect(stored.find((t) => t._id === other)?.deleted_at).toBeNull();
  });

  it('brings a deleted token back under whoever signs in on that device next', async () => {
    const store = createDeviceTokenStore(tokens());
    const token = newToken();
    const [deleted, next] = [randomUUID(), randomUUID()];
    await store.register(token, deleted, new Date('2026-10-25T12:00:00Z'));
    await store.softDeleteOwnedBy(deleted, new Date('2026-10-26T12:00:00Z'));

    await store.register(token, next, new Date('2026-10-27T12:00:00Z'));

    expect(await tokens().findOne({ _id: token })).toMatchObject({
      account_id: next,
      deleted_at: null,
    });
  });

  it('reads the tokens of an account from the index, without scanning the collection', async () => {
    const plan = await tokens().find(activeTokensFilter(randomUUID())).explain();

    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winning).toContain('account_id_1_deleted_at_1');
    expect(winning).not.toContain('COLLSCAN');
  });

  it('lists the tokens an account can be pushed to, leaving out the deleted and the moved', async () => {
    const store = createDeviceTokenStore(tokens());
    const [phone, tablet, moved, other] = [newToken(), newToken(), newToken(), newToken()];
    const [account, someoneElse] = [randomUUID(), randomUUID()];
    const at = new Date('2026-10-25T12:00:00Z');
    for (const token of [phone, tablet, moved]) {
      await store.register(token, account, at);
    }
    await store.register(other, someoneElse, at);
    await store.register(moved, someoneElse, new Date('2026-10-26T12:00:00Z'));
    await tokens().updateOne({ _id: tablet }, { $set: { deleted_at: at } });

    expect(await store.activeTokensOf(account)).toEqual([phone]);
  });

  it('marks the given tokens deleted, keeping the first date and touching no other', async () => {
    const store = createDeviceTokenStore(tokens());
    const [gone, live] = [newToken(), newToken()];
    const account = randomUUID();
    await store.register(gone, account, new Date('2026-10-25T12:00:00Z'));
    await store.register(live, account, new Date('2026-10-25T12:00:00Z'));
    const first = new Date('2026-10-27T08:00:00Z');

    await store.softDelete([gone], first);
    await store.softDelete([gone], new Date('2026-10-28T08:00:00Z'));

    expect((await tokens().findOne({ _id: gone }))?.deleted_at).toEqual(first);
    expect((await tokens().findOne({ _id: live }))?.deleted_at).toBeNull();
  });
});
