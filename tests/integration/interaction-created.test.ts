import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInteractionCreatedHandler } from '../../src/app/interactions';
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
import { exampleEvent, type EventEnvelope } from '../support/contracts';

// The handler with the real stores; only FCM is a double. That the queue gets
// the event from the exchange is in email-consumer.test.ts, which owns the
// queue in this suite.
const { MONGODB_URL } = process.env;
if (!MONGODB_URL) {
  throw new Error('tests/integration needs MONGODB_URL');
}

let mongo: MongoClient;
const accounts: string[] = [];
const tokenIds: string[] = [];

const tokens = () => deviceTokenCollection(mongo);
const notifications = () => notificationCollection(mongo);

/** FCM as a double: records every push and reports no token gone. */
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

function handler(push: PushSender) {
  return createInteractionCreatedHandler({
    notifications: createNotificationStore(notifications()),
    deviceTokens: createDeviceTokenStore(tokens()),
    preferences: createPreferenceStore(preferenceCollection(mongo)),
    push,
  });
}

function newAccount(): string {
  const account = randomUUID();
  accounts.push(account);
  return account;
}

async function newDevice(account: string): Promise<string> {
  const token = `fcm-${randomUUID()}`;
  tokenIds.push(token);
  await createDeviceTokenStore(tokens()).register(token, account, new Date());
  return token;
}

/** A fresh interaction of `kind` on a post of `author`, by a new account. */
function interactionOn(author: string, kind = 'like'): EventEnvelope {
  const event = exampleEvent('interaction.created.v1', randomUUID());
  event.data.kind = kind;
  event.data.actor_id = newAccount();
  event.data.post_id = randomUUID();
  event.data.post_author_id = author;
  if (kind === 'reply') {
    event.data.reply_id = randomUUID();
  }
  return event;
}

beforeAll(() => {
  mongo = createMongoClient(MONGODB_URL);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(async () => {
  await Promise.all([
    tokens().deleteMany({ _id: { $in: tokenIds } }),
    notifications().deleteMany({ recipient_id: { $in: accounts } }),
  ]);
  await mongo.close();
});

describe('interaction.created against MongoDB', () => {
  it('E4-H2.CA1 el mensaje trae tipo y nombre de usuario', async () => {
    const author = newAccount();
    const phone = await newDevice(author);
    await newDevice(newAccount());
    const { push, sent } = fakePush();

    await expect(handler(push)(JSON.stringify(interactionOn(author, 'retweet')))).resolves.toBe(
      'ack'
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].tokens).toEqual([phone]);
    expect(sent[0].message).toMatchObject({
      title: 'Nuevo retweet',
      body: '@juanperez retuiteó tu publicación',
    });
  });

  it('E4-H2.CA2 payload lleva el id del post', async () => {
    const author = newAccount();
    await newDevice(author);
    const reply = interactionOn(author, 'reply');
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(reply));

    expect(sent[0].message.data).toEqual({ type: 'reply', postId: reply.data.post_id });
  });

  it('adds the interaction to the notification center of the post author', async () => {
    const author = newAccount();
    const reply = interactionOn(author, 'reply');

    await handler(fakePush().push)(JSON.stringify(reply));

    expect(await notifications().findOne({ _id: reply.id })).toEqual({
      _id: reply.id,
      recipient_id: author,
      type: 'reply',
      actor_id: reply.data.actor_id,
      actor_handle: 'juanperez',
      post_id: reply.data.post_id,
      reply_id: reply.data.reply_id,
      created_at: new Date(reply.time),
      read_at: null,
      deleted_at: null,
    });
  });

  it('E4-H2.CA1 la misma interacción no genera dos notificaciones', async () => {
    const author = newAccount();
    await newDevice(author);
    const like = interactionOn(author);
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(like));
    await expect(handler(push)(JSON.stringify(like))).resolves.toBe('ack');

    expect(sent).toHaveLength(1);
    expect(await notifications().countDocuments({ _id: like.id })).toBe(1);
  });
});
