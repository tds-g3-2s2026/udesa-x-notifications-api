import { randomUUID } from 'node:crypto';

import { MongoServerError, type Collection } from 'mongodb';
import { describe, expect, it } from 'vitest';

import {
  createNotificationStore,
  type NotificationRecord,
} from '../../src/infrastructure/notification-store';
import { aNotification } from '../support/notifications';

// Only the insert `add` makes. The happy paths and the duplicate run against a
// real MongoDB in tests/integration; these are the failures hard to cause there.
function failingCollection(error: Error) {
  return {
    insertOne: async () => {
      throw error;
    },
  } as unknown as Collection<NotificationRecord>;
}

describe('notification store', () => {
  it.each([
    [
      'another MongoDB error',
      new MongoServerError({ message: 'Document failed validation', code: 121 }),
    ],
    ['a connection error', new Error('connect ECONNREFUSED')],
  ])('throws %s on add instead of taking it for a duplicate', async (_name, error) => {
    const store = createNotificationStore(failingCollection(error));

    await expect(store.add(aNotification(randomUUID()))).rejects.toBe(error);
  });
});
