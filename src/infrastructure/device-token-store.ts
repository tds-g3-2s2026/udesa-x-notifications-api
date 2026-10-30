import type { Collection, MongoClient } from 'mongodb';

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

    async softDeleteOwnedBy(accountId, at) {
      await tokens.updateMany(
        { account_id: accountId, deleted_at: null },
        { $set: { deleted_at: at } }
      );
    },
  };
}
