import { MongoClient } from 'mongodb';

import type { DependencyCheck } from './health';

// Under the 3 s the readiness probe waits, so a dead server shows up as
// "degraded" with its reason instead of as a probe timeout.
const SERVER_SELECTION_TIMEOUT_MS = 2000;

/**
 * The driver connects on the first operation and reconnects on its own, so
 * the service starts even with MongoDB down and recovers when it comes back.
 * The database is the one in the URL path.
 */
export function createMongoClient(url: string): MongoClient {
  return new MongoClient(url, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
}

export function mongodbCheck(client: MongoClient): DependencyCheck {
  return {
    name: 'mongodb',
    async check() {
      await client.db().command({ ping: 1 });
    },
  };
}
