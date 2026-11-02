import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFollowCreatedHandler } from '../../src/app/follows';
import type { PushMessage, PushResult, PushSender } from '../../src/app/push';
import {
  createDeviceTokenStore,
  deviceTokenCollection,
} from '../../src/infrastructure/device-token-store';
import { createMongoClient } from '../../src/infrastructure/mongodb';
import {
  createNotificationStore,
  notificationCollection,
} from '../../src/infrastructure/notification-store';
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

/** FCM as a double: records every push, and answers what the test says. */
function fakePush(answer: (tokens: string[]) => PushResult = () => ({ invalidTokens: [] })) {
  const sent: { tokens: string[]; message: PushMessage }[] = [];
  const push: PushSender = {
    async send(tokens, message) {
      sent.push({ tokens, message });
      return answer(tokens);
    },
  };
  return { push, sent };
}

function handler(push: PushSender) {
  return createFollowCreatedHandler({
    notifications: createNotificationStore(notifications()),
    deviceTokens: createDeviceTokenStore(tokens()),
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

function followOf(followee: string): EventEnvelope {
  const event = exampleEvent('follow.created.v1', randomUUID());
  event.data.follower_id = newAccount();
  event.data.followee_id = followee;
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

describe('follow.created against MongoDB', () => {
  it('E4-H1.CA1 envía push por FCM al usuario seguido', async () => {
    const followee = newAccount();
    const [phone, tablet] = [await newDevice(followee), await newDevice(followee)];
    const deleted = await newDevice(followee);
    await tokens().updateOne({ _id: deleted }, { $set: { deleted_at: new Date() } });
    await newDevice(newAccount());
    const { push, sent } = fakePush();

    await expect(handler(push)(JSON.stringify(followOf(followee)))).resolves.toBe('ack');

    expect(sent).toHaveLength(1);
    expect(sent[0].tokens.sort()).toEqual([phone, tablet].sort());
    expect(sent[0].message).toMatchObject({
      title: 'Nuevo seguidor',
      body: '@juanperez te empezó a seguir',
    });
  });

  it('E4-H1.CA2 payload lleva el id del nuevo seguidor', async () => {
    const followee = newAccount();
    await newDevice(followee);
    const event = followOf(followee);
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(event));

    expect(sent[0].message.data).toEqual({ type: 'follow', actorId: event.data.follower_id });
  });

  it('adds the follow to the notification center of the followed account', async () => {
    const followee = newAccount();
    const event = followOf(followee);

    await handler(fakePush().push)(JSON.stringify(event));

    expect(await notifications().findOne({ _id: event.id })).toEqual({
      _id: event.id,
      recipient_id: followee,
      type: 'follow',
      actor_id: event.data.follower_id,
      actor_handle: 'juanperez',
      post_id: null,
      reply_id: null,
      created_at: new Date(event.time),
      read_at: null,
      deleted_at: null,
    });
  });

  it('sends one push and keeps one entry when the same event arrives twice', async () => {
    const followee = newAccount();
    await newDevice(followee);
    const event = followOf(followee);
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(event));
    await expect(handler(push)(JSON.stringify(event))).resolves.toBe('ack');

    expect(sent).toHaveLength(1);
    expect(await notifications().countDocuments({ _id: event.id })).toBe(1);
  });
});
