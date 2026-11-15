import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NOTIFICATION_TYPES, type NotificationType } from '../../src/app/preferences';
import { createMongoClient } from '../../src/infrastructure/mongodb';
import {
  createPreferenceStore,
  preferenceCollection,
} from '../../src/infrastructure/preference-store';
import { buildApp } from '../support/app';
import { issueToken } from '../support/auth';

// The routes with the real store: the dotted-path upsert is what lets one
// switch be saved without touching the others, and only MongoDB can prove it.
const { MONGODB_URL } = process.env;
if (!MONGODB_URL) {
  throw new Error('tests/integration needs MONGODB_URL');
}

let mongo: MongoClient;
const accounts: string[] = [];

const preferences = () => preferenceCollection(mongo);

function newAccount(): string {
  const account = randomUUID();
  accounts.push(account);
  return account;
}

const ALL_ON = Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, true]));

/** A request to /api/notifications/preferences as `account`; `body` goes as is. */
async function call(method: 'GET' | 'PUT', account: string, body?: string) {
  const app = buildApp({ preferences: createPreferenceStore(preferences()) });
  return app.request('/api/notifications/preferences', {
    method,
    headers: {
      authorization: `Bearer ${await issueToken({ sub: account })}`,
      'content-type': 'application/json',
    },
    body,
  });
}

const put = (account: string, changes: unknown) => call('PUT', account, JSON.stringify(changes));

beforeAll(() => {
  mongo = createMongoClient(MONGODB_URL);
});

afterAll(async () => {
  await preferences().deleteMany({ _id: { $in: accounts } });
  await mongo.close();
});

describe('GET /api/notifications/preferences against MongoDB', () => {
  it('answers everything on for an account that never chose, writing nothing', async () => {
    const account = newAccount();

    const res = await call('GET', account);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ALL_ON);
    expect(await preferences().countDocuments({ _id: account })).toBe(0);
  });

  it('answers 401 without an access token', async () => {
    const res = await buildApp().request('/api/notifications/preferences');

    expect(res.status).toBe(401);
  });
});

describe('PUT /api/notifications/preferences against MongoDB', () => {
  it('E4-H5.CA1 - saves each of the six types on its own', async () => {
    const account = newAccount();
    expect(NOTIFICATION_TYPES).toHaveLength(6);

    const turnedOff: NotificationType[] = [];
    for (const type of NOTIFICATION_TYPES) {
      const res = await put(account, { [type]: false });
      turnedOff.push(type);

      const expected = { ...ALL_ON, ...Object.fromEntries(turnedOff.map((t) => [t, false])) };
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expected);
      // What a later read answers is the same, and the account's own.
      expect(await (await call('GET', account)).json()).toEqual(expected);
    }

    // Turning one back on leaves the other five off.
    await put(account, { mention: true });
    expect(await (await call('GET', account)).json()).toEqual({
      ...Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, false])),
      mention: true,
    });
  });

  it('keeps only what the account chose, so a type it never touched stays unwritten', async () => {
    const account = newAccount();

    await put(account, { like: false });

    expect(await preferences().findOne({ _id: account })).toEqual({
      _id: account,
      preferences: { like: false },
      updated_at: expect.any(Date),
    });
  });

  it('saves several types in one request', async () => {
    const account = newAccount();

    await put(account, { like: false, retweet: false, follow: true });

    expect(await (await call('GET', account)).json()).toEqual({
      ...ALL_ON,
      like: false,
      retweet: false,
    });
  });

  it('works on the account of the token and touches no other', async () => {
    const [account, other] = [newAccount(), newAccount()];

    await put(account, { like: false });

    expect(await (await call('GET', other)).json()).toEqual(ALL_ON);
  });

  it('answers 401 without an access token, storing nothing', async () => {
    const res = await buildApp().request('/api/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify({ like: false }),
    });

    expect(res.status).toBe(401);
  });

  it.each([
    ['a body that is not JSON', '{like:', [{ field: 'body' }]],
    ['JSON null', 'null', [{ field: 'body' }]],
    ['a list', '[true]', [{ field: 'body' }]],
    ['a type that does not exist', '{"share":false}', [{ field: 'share' }]],
    ['a value that is not a boolean', '{"like":"no"}', [{ field: 'like' }]],
    [
      'several wrong fields',
      '{"like":1,"share":true,"reply":false}',
      [{ field: 'like' }, { field: 'share' }],
    ],
  ])('answers 422 naming the fields for %s, storing nothing', async (_, body, errors) => {
    const account = newAccount();

    const res = await call('PUT', account, body);

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await res.json()).toMatchObject({
      type: 'https://udesa-x.dev/errors/validation-failed',
      status: 422,
      errors: errors.map((error) => ({ ...error, message: expect.any(String) })),
    });
    expect(await preferences().countDocuments({ _id: account })).toBe(0);
  });
});
