import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMongoClient } from '../../src/infrastructure/mongodb';
import {
  createNotificationStore,
  notificationCollection,
} from '../../src/infrastructure/notification-store';
import { buildApp, requestAs } from '../support/app';
import { aNotification } from '../support/notifications';

const { MONGODB_URL } = process.env;
if (!MONGODB_URL) {
  throw new Error('tests/integration needs MONGODB_URL');
}

let mongo: MongoClient;
const accounts: string[] = [];

const notifications = () => notificationCollection(mongo);

function newAccount(): string {
  const account = randomUUID();
  accounts.push(account);
  return account;
}

async function seed(account: string): Promise<string> {
  const notification = aNotification(account);
  await createNotificationStore(notifications()).add(notification);
  return notification.id;
}

const app = () => buildApp({ notifications: createNotificationStore(notifications()) });

const remove = (account: string, id: string) =>
  requestAs(app(), account, `/api/notifications/${id}`, 'DELETE');

beforeAll(() => {
  mongo = createMongoClient(MONGODB_URL);
});

afterAll(async () => {
  await notifications().deleteMany({ recipient_id: { $in: accounts } });
  await mongo.close();
});

describe('DELETE /api/notifications/:id against MongoDB', () => {
  it('E4-H3.CA5 borrar marca deleted_at y no elimina el documento', async () => {
    const account = newAccount();
    const id = await seed(account);

    const res = await remove(account, id);

    expect(res.status).toBe(204);
    const stored = await notifications().findOne({ _id: id });
    expect(stored).not.toBeNull();
    expect(stored?.deleted_at).toBeInstanceOf(Date);
  });

  it('E4-H3.CA4 borrar una notificación la oculta del listado', async () => {
    const account = newAccount();
    const deleted = await seed(account);
    const kept = await seed(account);

    await remove(account, deleted);
    const res = await requestAs(app(), account, '/api/notifications');

    const { items } = (await res.json()) as { items: { id: string }[] };
    expect(items.map((item) => item.id)).toEqual([kept]);
  });

  it('answers 204 again for one already deleted, keeping the first date', async () => {
    const account = newAccount();
    const id = await seed(account);
    await remove(account, id);
    const first = (await notifications().findOne({ _id: id }))?.deleted_at;

    const res = await remove(account, id);

    expect(res.status).toBe(204);
    expect((await notifications().findOne({ _id: id }))?.deleted_at).toEqual(first);
  });

  it("answers 404 for another account's notification, leaving it as it was", async () => {
    const owner = newAccount();
    const id = await seed(owner);

    const res = await remove(newAccount(), id);

    expect(res.status).toBe(404);
    expect((await notifications().findOne({ _id: id }))?.deleted_at).toBeNull();
  });

  it('answers 404 for an id that does not exist', async () => {
    const res = await remove(newAccount(), randomUUID());

    expect(res.status).toBe(404);
  });
});
