import { MongoServerError, type Collection } from 'mongodb';
import { describe, expect, it } from 'vitest';

import {
  createProcessedEventStore,
  type ProcessedEventRecord,
} from '../../src/infrastructure/processed-event-store';

const event = { id: 'event-1', type: 'user.deleted.v1', userId: 'user-1' };
const at = new Date('2026-10-30T12:00:00Z');

// Only the insert `record` makes. The rest runs against a real MongoDB in
// tests/integration; these are the outcomes hard to cause there.
function failingCollection(error: Error) {
  return {
    insertOne: async () => {
      throw error;
    },
  } as unknown as Collection<ProcessedEventRecord>;
}

describe('processed event store', () => {
  it('takes a duplicate key as already recorded', async () => {
    const duplicate = new MongoServerError({ message: 'E11000 duplicate key', code: 11000 });
    const store = createProcessedEventStore(failingCollection(duplicate));

    await expect(store.record(event, at)).resolves.toBeUndefined();
  });

  it.each([
    [
      'another MongoDB error',
      new MongoServerError({ message: 'Document failed validation', code: 121 }),
    ],
    ['a connection error', new Error('connect ECONNREFUSED')],
  ])('throws %s instead of taking it for a duplicate', async (_name, error) => {
    const store = createProcessedEventStore(failingCollection(error));

    await expect(store.record(event, at)).rejects.toBe(error);
  });
});
