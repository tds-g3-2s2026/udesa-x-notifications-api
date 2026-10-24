import { MongoServerError, type Collection, type MongoClient } from 'mongodb';

import type { EmailRecord, EmailStatus, EmailStore } from '../app/email-events';

const DUPLICATE_KEY = 11000;

// `_id` is the event id and MongoDB indexes it as unique: that index is what
// makes the insert in `insertPending` the idempotency check.
export function emailCollection(client: MongoClient): Collection<EmailRecord> {
  return client.db().collection<EmailRecord>('emails');
}

export function createEmailStore(emails: Collection<EmailRecord>): EmailStore {
  return {
    async insertPending(record) {
      try {
        await emails.insertOne(record);
        return null;
      } catch (error) {
        if (!(error instanceof MongoServerError && error.code === DUPLICATE_KEY)) {
          throw error;
        }
      }
      const existing = await emails.findOne<{ status: EmailStatus }>(
        { _id: record._id },
        { projection: { status: 1 } }
      );
      if (!existing) {
        // Deleted between the insert and the read: let the broker redeliver.
        throw new Error(`Email record ${record._id} vanished during the duplicate check`);
      }
      return existing.status;
    },

    async finish(id, status, sentAt) {
      await emails.updateOne({ _id: id }, { $set: { status, sent_at: sentAt } });
    },
  };
}
