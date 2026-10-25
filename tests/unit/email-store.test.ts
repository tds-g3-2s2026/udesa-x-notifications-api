import { MongoServerError, type Collection } from 'mongodb';
import { describe, expect, it } from 'vitest';

import type { EmailRecord } from '../../src/app/email-events';
import { createEmailStore } from '../../src/infrastructure/email-store';

const record: EmailRecord = {
  _id: 'event-1',
  type: 'password.changed.v1',
  user_id: 'user-1',
  to: 'ana@example.com',
  status: 'pending',
  created_at: new Date('2026-10-24T12:00:00Z'),
  sent_at: null,
};

// Only the two calls `insertPending` makes. The happy paths run against a real
// MongoDB in tests/integration; these are the failures that are hard to cause there.
function fakeCollection(insertError: Error, existing: { status: string } | null) {
  return {
    insertOne: async () => {
      throw insertError;
    },
    findOne: async () => existing,
  } as unknown as Collection<EmailRecord>;
}

describe('email store', () => {
  it.each([
    [
      'another MongoDB error',
      new MongoServerError({ message: 'Document failed validation', code: 121 }),
    ],
    ['a connection error', new Error('connect ECONNREFUSED')],
  ])('throws %s on insert instead of taking it for a duplicate', async (_name, error) => {
    const store = createEmailStore(fakeCollection(error, { status: 'sent' }));

    await expect(store.insertPending(record)).rejects.toBe(error);
  });

  it('throws when the duplicate record is gone before it can be read, so the event is redelivered', async () => {
    const duplicate = new MongoServerError({ message: 'E11000 duplicate key', code: 11000 });
    const store = createEmailStore(fakeCollection(duplicate, null));

    await expect(store.insertPending(record)).rejects.toThrow(
      'vanished during the duplicate check'
    );
  });
});
