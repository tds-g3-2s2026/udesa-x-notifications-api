import type { Collection, MongoClient } from 'mongodb';

import type { PreferenceStore, Preferences } from '../app/preferences';

export interface PreferenceRecord {
  /** The account: one document each, and MongoDB's own `_id` index finds it. */
  _id: string;
  /** Only the types the account chose; a missing one is on. */
  preferences: Partial<Preferences>;
  updated_at: Date;
}

export function preferenceCollection(client: MongoClient): Collection<PreferenceRecord> {
  return client.db().collection<PreferenceRecord>('notification_preferences');
}

export function createPreferenceStore(preferences: Collection<PreferenceRecord>): PreferenceStore {
  return {
    async chosenBy(accountId) {
      const record = await preferences.findOne({ _id: accountId });
      return record?.preferences ?? {};
    },

    async set(accountId, changes, at) {
      // One atomic upsert that writes only the given types, so two switches
      // saved at the same time do not undo each other.
      const chosen = Object.fromEntries(
        Object.entries(changes).map(([type, on]) => [`preferences.${type}`, on])
      );
      await preferences.updateOne(
        { _id: accountId },
        { $set: { ...chosen, updated_at: at } },
        { upsert: true }
      );
    },

    async deleteOwnedBy(accountId) {
      await preferences.deleteOne({ _id: accountId });
    },
  };
}
