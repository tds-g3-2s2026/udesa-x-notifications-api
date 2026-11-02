import type { Collection, Filter, MongoClient } from 'mongodb';

import type { DeviceTokenStore } from '../app/device-tokens';

export interface DeviceTokenRecord {
  /** The token itself: unique by MongoDB's own `_id` index, one owner per device. */
  _id: string;
  account_id: string;
  updated_at: Date;
  /** Set when the account is deleted. Nothing sends to a deleted token. */
  deleted_at: Date | null;
}

export function deviceTokenCollection(client: MongoClient): Collection<DeviceTokenRecord> {
  return client.db().collection<DeviceTokenRecord>('device_tokens');
}

/**
 * Every read by account (the tokens a push goes to, the ones an account
 * deletion marks) filters by account and by not deleted.
 */
export const ACCOUNT_INDEX = { account_id: 1, deleted_at: 1 } as const;

/** Creates the index if it is missing. MongoDB does nothing when it already exists. */
export async function ensureDeviceTokenIndexes(
  tokens: Collection<DeviceTokenRecord>
): Promise<void> {
  await tokens.createIndex(ACCOUNT_INDEX);
}

/** The query behind `activeTokensOf`, apart so the tests can ask MongoDB how it runs it. */
export function activeTokensFilter(accountId: string): Filter<DeviceTokenRecord> {
  return { account_id: accountId, deleted_at: null };
}

export function createDeviceTokenStore(tokens: Collection<DeviceTokenRecord>): DeviceTokenStore {
  return {
    async register(token, accountId, at) {
      // One atomic upsert: two logins racing on the same device end with one
      // document, owned by whichever wrote last.
      await tokens.updateOne(
        { _id: token },
        { $set: { account_id: accountId, updated_at: at, deleted_at: null } },
        { upsert: true }
      );
    },

    async activeTokensOf(accountId) {
      const records = await tokens
        .find(activeTokensFilter(accountId), { projection: { _id: 1 } })
        .toArray();
      return records.map((record) => record._id);
    },

    async softDelete(ids, at) {
      await tokens.updateMany(
        { _id: { $in: ids }, deleted_at: null },
        { $set: { deleted_at: at } }
      );
    },

    async softDeleteOwnedBy(accountId, at) {
      await tokens.updateMany(
        { account_id: accountId, deleted_at: null },
        { $set: { deleted_at: at } }
      );
    },
  };
}
