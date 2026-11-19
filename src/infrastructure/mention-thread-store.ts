import { MongoServerError, type Collection, type MongoClient } from 'mongodb';

import type { MentionThreadStore } from '../app/mentions';

const DUPLICATE_KEY = 11000;

export interface MentionThreadRecord {
  /** The id of the event that opened the thread for that account and author. */
  _id: string;
  recipient_id: string;
  author_id: string;
  /** The root post of the thread, which travels in the event. */
  thread_id: string;
  created_at: Date;
}

export function mentionThreadCollection(client: MongoClient): Collection<MentionThreadRecord> {
  return client.db().collection<MentionThreadRecord>('mention_threads');
}

/** One record per mentioned account, author and thread: this index is what keeps the rule. */
export const THREAD_INDEX = { recipient_id: 1, author_id: 1, thread_id: 1 } as const;

export function createMentionThreadStore(
  threads: Collection<MentionThreadRecord>
): MentionThreadStore {
  // Created before the first record and not at startup: the service starts with
  // MongoDB down and does not come back to create it, and with no index a second
  // mention in the same thread would be notified. MongoDB does nothing when it exists.
  let indexed: Promise<unknown> | null = null;
  function ensureIndex() {
    indexed ??= threads.createIndex(THREAD_INDEX, { unique: true }).catch((error: unknown) => {
      indexed = null;
      throw error;
    });
    return indexed;
  }

  return {
    async claim({ recipientId, authorId, threadId }, eventId, at) {
      await ensureIndex();
      try {
        await threads.insertOne({
          _id: eventId,
          recipient_id: recipientId,
          author_id: authorId,
          thread_id: threadId,
          created_at: at,
        });
        return true;
      } catch (error) {
        if (!(error instanceof MongoServerError && error.code === DUPLICATE_KEY)) {
          throw error;
        }
        // The record is there. It is this event's own when the event came again after
        // a failure further on, and then it still has to be handled; if another event
        // holds it, somebody was already told about this thread.
        return (await threads.countDocuments({ _id: eventId }, { limit: 1 })) > 0;
      }
    },
  };
}
