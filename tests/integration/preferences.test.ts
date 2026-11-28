import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFollowCreatedHandler } from '../../src/app/follows';
import { createInteractionCreatedHandler } from '../../src/app/interactions';
import { NOTIFICATION_TYPES, wantsPush, type NotificationType } from '../../src/app/preferences';
import type { PushMessage, PushSender } from '../../src/app/push';
import {
  createDeviceTokenStore,
  deviceTokenCollection,
} from '../../src/infrastructure/device-token-store';
import { createMongoClient } from '../../src/infrastructure/mongodb';
import {
  createNotificationStore,
  notificationCollection,
} from '../../src/infrastructure/notification-store';
import {
  createPreferenceStore,
  preferenceCollection,
} from '../../src/infrastructure/preference-store';
import { buildApp } from '../support/app';
import { issueToken } from '../support/auth';
import { exampleEvent } from '../support/contracts';

// The routes with the real store: the dotted-path upsert is what lets one
// switch be saved without touching the others, and only MongoDB can prove it.
const { MONGODB_URL } = process.env;
if (!MONGODB_URL) {
  throw new Error('tests/integration needs MONGODB_URL');
}

let mongo: MongoClient;
const accounts: string[] = [];
const tokenIds: string[] = [];

const preferences = () => preferenceCollection(mongo);
const tokens = () => deviceTokenCollection(mongo);
const notifications = () => notificationCollection(mongo);

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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterAll(async () => {
  await Promise.all([
    preferences().deleteMany({ _id: { $in: accounts } }),
    tokens().deleteMany({ _id: { $in: tokenIds } }),
    notifications().deleteMany({ recipient_id: { $in: accounts } }),
  ]);
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

describe('wantsPush against MongoDB', () => {
  const store = () => createPreferenceStore(preferences());

  it('wants every push for an account that never chose', async () => {
    const account = newAccount();

    for (const type of NOTIFICATION_TYPES) {
      expect(await wantsPush(store(), account, type)).toBe(true);
    }
  });

  it('turns off only the type the account turned off, until it turns it back on', async () => {
    const account = newAccount();

    await store().set(account, { like: false }, new Date());
    expect(await wantsPush(store(), account, 'like')).toBe(false);
    expect(await wantsPush(store(), account, 'retweet')).toBe(true);

    await store().set(account, { like: true }, new Date());
    expect(await wantsPush(store(), account, 'like')).toBe(true);
  });

  it('wants the push of a type the service does not know, since nothing turns it off', async () => {
    const account = newAccount();
    await store().set(account, { like: false }, new Date());

    expect(await wantsPush(store(), account, 'share')).toBe(true);
  });
});

describe('PUT /api/notifications/preferences against MongoDB', () => {
  it('E4-H5.CA1 - saves each of the seven types on its own', async () => {
    const account = newAccount();
    expect(NOTIFICATION_TYPES).toHaveLength(7);

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

    // Turning one back on leaves the other six off.
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

  it('deletes what an account chose and nothing of another, and repeating it is harmless', async () => {
    const [account, other] = [newAccount(), newAccount()];
    const store = createPreferenceStore(preferences());
    await put(account, { like: false });
    await put(other, { like: false });

    await store.deleteOwnedBy(account);
    await store.deleteOwnedBy(account);

    expect(await (await call('GET', account)).json()).toEqual(ALL_ON);
    expect(await preferences().countDocuments({ _id: account })).toBe(0);
    expect(await (await call('GET', other)).json()).toMatchObject({ like: false });
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

/** FCM as a double: records every push. */
function fakePush() {
  const sent: { tokens: string[]; message: PushMessage }[] = [];
  const push: PushSender = {
    async send(tokens, message) {
      sent.push({ tokens, message });
      return { invalidTokens: [] };
    },
  };
  return { push, sent };
}

/** The handlers that notify, with the real stores and only FCM as a double. */
function handlers(push: PushSender) {
  const deps = {
    notifications: createNotificationStore(notifications()),
    deviceTokens: createDeviceTokenStore(tokens()),
    preferences: createPreferenceStore(preferences()),
    push,
  };
  return {
    interaction: createInteractionCreatedHandler(deps),
    follow: createFollowCreatedHandler(deps),
  };
}

async function newDevice(account: string): Promise<string> {
  const token = `fcm-${randomUUID()}`;
  tokenIds.push(token);
  await createDeviceTokenStore(tokens()).register(token, account, new Date());
  return token;
}

/** A fresh interaction of `kind` on a post of `author`. */
function interactionOn(author: string, kind: string) {
  const event = exampleEvent('interaction.created.v1', randomUUID());
  event.data.kind = kind;
  event.data.actor_id = randomUUID();
  event.data.post_author_id = author;
  if (kind === 'reply') {
    event.data.reply_id = randomUUID();
  }
  if (kind === 'quote') {
    event.data.quote_id = randomUUID();
  }
  return event;
}

describe('preferences before the push against MongoDB', () => {
  it('E4-H5.CA2 - sends no push for a type the user turned off', async () => {
    const account = newAccount();
    await newDevice(account);
    await put(account, { like: false });
    const { push, sent } = fakePush();
    const like = interactionOn(account, 'like');

    await expect(handlers(push).interaction(JSON.stringify(like))).resolves.toBe('ack');

    expect(sent).toHaveLength(0);
    // The preference is about alerts: the center shows the entry all the same.
    expect(await notifications().findOne({ _id: like.id })).toMatchObject({
      recipient_id: account,
      type: 'like',
      deleted_at: null,
    });
  });

  it('E4-H5.CA2 - sends the push when the user never chose', async () => {
    const account = newAccount();
    const phone = await newDevice(account);
    const { push, sent } = fakePush();

    await handlers(push).interaction(JSON.stringify(interactionOn(account, 'like')));

    expect(sent).toHaveLength(1);
    expect(sent[0].tokens).toEqual([phone]);
  });

  it('E4-H5.CA2 - sends no push for a quote once quotes are turned off', async () => {
    const account = newAccount();
    await newDevice(account);
    await put(account, { quote: false });
    const { push, sent } = fakePush();
    const { interaction } = handlers(push);

    await interaction(JSON.stringify(interactionOn(account, 'quote')));
    expect(sent).toHaveLength(0);

    // Quotes are a type of their own: retweets still arrive.
    await interaction(JSON.stringify(interactionOn(account, 'retweet')));
    expect(sent.map((s) => s.message.data.type)).toEqual(['retweet']);
  });

  it('turns off only the type the user chose, for every kind of notification', async () => {
    const account = newAccount();
    await newDevice(account);
    await put(account, { like: false, follow: false });
    const { push, sent } = fakePush();
    const { interaction, follow } = handlers(push);

    await interaction(JSON.stringify(interactionOn(account, 'like')));
    const followEvent = exampleEvent('follow.created.v1', randomUUID());
    followEvent.data.followee_id = account;
    await follow(JSON.stringify(followEvent));
    expect(sent).toHaveLength(0);

    await interaction(JSON.stringify(interactionOn(account, 'retweet')));
    expect(sent.map((s) => s.message.data.type)).toEqual(['retweet']);
  });

  it('sends the push again once the user turns the type back on', async () => {
    const account = newAccount();
    await newDevice(account);
    const { push, sent } = fakePush();
    const { interaction } = handlers(push);

    await put(account, { reply: false });
    await interaction(JSON.stringify(interactionOn(account, 'reply')));
    await put(account, { reply: true });
    await interaction(JSON.stringify(interactionOn(account, 'reply')));

    expect(sent).toHaveLength(1);
  });

  it('does not push later an event that arrived while the type was off', async () => {
    const account = newAccount();
    await newDevice(account);
    const { push, sent } = fakePush();
    const { interaction } = handlers(push);
    const like = JSON.stringify(interactionOn(account, 'like'));

    await put(account, { like: false });
    await interaction(like);
    await put(account, { like: true });
    await interaction(like);

    // The first delivery left the entry, which is what marks the event as seen.
    expect(sent).toHaveLength(0);
  });
});
