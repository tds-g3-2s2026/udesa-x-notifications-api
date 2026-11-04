import {
  MongoServerError,
  type Collection,
  type Filter,
  type MongoClient,
  type Sort,
} from 'mongodb';

import type { Notification, NotificationStore, PagePosition } from '../app/notifications';

const DUPLICATE_KEY = 11000;

export interface NotificationRecord {
  /** The id of the event that produced it: the unique `_id` index makes `add` idempotent. */
  _id: string;
  recipient_id: string;
  type: string;
  actor_id: string;
  actor_handle: string | null;
  post_id: string | null;
  reply_id: string | null;
  created_at: Date;
  read_at: Date | null;
  deleted_at: Date | null;
}

export function notificationCollection(client: MongoClient): Collection<NotificationRecord> {
  return client.db().collection<NotificationRecord>('notifications');
}

/**
 * The listing filters by account and by not deleted, and sorts by date with
 * the id as tiebreak: the index has exactly those keys in that order, so a page
 * is read straight from it however many notifications the account has.
 */
export const LISTING_INDEX = { recipient_id: 1, deleted_at: 1, created_at: -1, _id: -1 } as const;

/** Creates the index if it is missing. MongoDB does nothing when it already exists. */
export async function ensureNotificationIndexes(
  notifications: Collection<NotificationRecord>
): Promise<void> {
  await notifications.createIndex(LISTING_INDEX);
}

/** The query behind a page, apart so the tests can ask MongoDB how it runs it. */
export function pageQuery(
  recipientId: string,
  after: PagePosition | null
): { filter: Filter<NotificationRecord>; sort: Sort } {
  const filter: Filter<NotificationRecord> = { recipient_id: recipientId, deleted_at: null };
  if (after) {
    filter.$or = [
      { created_at: { $lt: after.createdAt } },
      { created_at: after.createdAt, _id: { $lt: after.id } },
    ];
  }
  return { filter, sort: { created_at: -1, _id: -1 } };
}

function toNotification(record: NotificationRecord): Notification {
  return {
    id: record._id,
    recipientId: record.recipient_id,
    type: record.type,
    actor: { id: record.actor_id, handle: record.actor_handle },
    postId: record.post_id,
    replyId: record.reply_id,
    createdAt: record.created_at,
    readAt: record.read_at,
  };
}

export function createNotificationStore(
  notifications: Collection<NotificationRecord>
): NotificationStore {
  return {
    async add(notification) {
      try {
        await notifications.insertOne({
          _id: notification.id,
          recipient_id: notification.recipientId,
          type: notification.type,
          actor_id: notification.actor.id,
          actor_handle: notification.actor.handle,
          post_id: notification.postId,
          reply_id: notification.replyId,
          created_at: notification.createdAt,
          read_at: null,
          deleted_at: null,
        });
        return true;
      } catch (error) {
        // Already there: the same event delivered again.
        if (!(error instanceof MongoServerError && error.code === DUPLICATE_KEY)) {
          throw error;
        }
        return false;
      }
    },

    async page(recipientId, limit, after) {
      const { filter, sort } = pageQuery(recipientId, after);
      const records = await notifications.find(filter).sort(sort).limit(limit).toArray();
      return records.map(toNotification);
    },

    async markAllRead(recipientId, at) {
      await notifications.updateMany(
        { recipient_id: recipientId, deleted_at: null, read_at: null },
        { $set: { read_at: at } }
      );
    },

    async softDelete(recipientId, id, at) {
      // The filter on `deleted_at` keeps the date of the first deletion.
      const { matchedCount } = await notifications.updateOne(
        { _id: id, recipient_id: recipientId, deleted_at: null },
        { $set: { deleted_at: at } }
      );
      if (matchedCount === 1) {
        return true;
      }
      // Nothing changed: either it was already deleted, or it is not this account's.
      return (
        (await notifications.countDocuments({ _id: id, recipient_id: recipientId }, { limit: 1 })) >
        0
      );
    },

    async softDeleteOwnedBy(recipientId, at) {
      await notifications.updateMany(
        { recipient_id: recipientId, deleted_at: null },
        { $set: { deleted_at: at } }
      );
    },
  };
}
