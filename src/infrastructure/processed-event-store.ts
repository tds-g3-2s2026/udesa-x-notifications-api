import { MongoServerError, type Collection, type MongoClient } from 'mongodb';

import type { ProcessedEventStore } from '../app/user-deletion';

const DUPLICATE_KEY = 11000;

export interface ProcessedEventRecord {
  /** The id of the event: MongoDB's unique `_id` index keeps one record per event. */
  _id: string;
  type: string;
  user_id: string;
  processed_at: Date;
}

export function processedEventCollection(client: MongoClient): Collection<ProcessedEventRecord> {
  return client.db().collection<ProcessedEventRecord>('processed_events');
}

export function createProcessedEventStore(
  events: Collection<ProcessedEventRecord>
): ProcessedEventStore {
  return {
    async has(id) {
      return (await events.countDocuments({ _id: id }, { limit: 1 })) > 0;
    },

    async record({ id, type, userId }, at) {
      try {
        await events.insertOne({ _id: id, type, user_id: userId, processed_at: at });
      } catch (error) {
        // Two deliveries of the same event finished at once: one record is enough.
        if (!(error instanceof MongoServerError && error.code === DUPLICATE_KEY)) {
          throw error;
        }
      }
    },
  };
}
