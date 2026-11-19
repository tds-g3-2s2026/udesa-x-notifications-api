import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREVIEW_LENGTH, createMentionCreatedHandler } from '../../src/app/mentions';
import type { PushMessage, PushSender } from '../../src/app/push';
import {
  createDeviceTokenStore,
  deviceTokenCollection,
} from '../../src/infrastructure/device-token-store';
import {
  createMentionThreadStore,
  mentionThreadCollection,
} from '../../src/infrastructure/mention-thread-store';
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
const preferences = () => preferenceCollection(mongo);
const threads = () => mentionThreadCollection(mongo);

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
  return createMentionCreatedHandler({
    notifications: createNotificationStore(notifications()),
    deviceTokens: createDeviceTokenStore(tokens()),
    preferences: createPreferenceStore(preferences()),
    push,
    mentionThreads: createMentionThreadStore(threads()),
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

/** A fresh mention of `mentioned` by a new account, with `content` as the text when given. */
function mentionOf(mentioned: string, content?: string): EventEnvelope {
  const event = exampleEvent('mention.created.v1', randomUUID());
  event.data.author_id = newAccount();
  event.data.mentioned_id = mentioned;
  event.data.post_id = randomUUID();
  event.data.root_post_id = randomUUID();
  if (content !== undefined) {
    event.data.content = content;
  }
  return event;
}

/** The mention as made by `author` in the thread whose root post is `thread`. */
function inThread(mention: EventEnvelope, author: string, thread: string): EventEnvelope {
  mention.data.author_id = author;
  mention.data.root_post_id = thread;
  return mention;
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
    preferences().deleteMany({ _id: { $in: accounts } }),
    threads().deleteMany({ recipient_id: { $in: accounts } }),
  ]);
  await mongo.close();
});

describe('mention.created against MongoDB', () => {
  it('E4-H4.CA1 - the push carries the first 100 characters', async () => {
    const mentioned = newAccount();
    const phone = await newDevice(mentioned);
    const text = 'palabra '.repeat(30).trim();
    const { push, sent } = fakePush();

    await expect(handler(push)(JSON.stringify(mentionOf(mentioned, text)))).resolves.toBe('ack');

    expect(sent).toHaveLength(1);
    expect(sent[0].tokens).toEqual([phone]);
    expect(sent[0].message.title).toBe('Nueva mención');
    const prefix = '@juanperez te mencionó: ';
    expect(sent[0].message.body.startsWith(prefix)).toBe(true);
    const preview = sent[0].message.body.slice(prefix.length);
    // What was left out is marked, the cut is the end of a word and it all fits in 100.
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_LENGTH);
    expect(text.startsWith(preview.slice(0, -1))).toBe(true);
    expect(text[preview.length - 1]).toBe(' ');
  });

  it('E4-H4.CA1 - a post that fits in 100 characters is quoted whole', async () => {
    const mentioned = newAccount();
    await newDevice(mentioned);
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(mentionOf(mentioned, 'Hola, ¿venís a la charla de hoy?')));

    expect(sent[0].message.body).toBe('@juanperez te mencionó: Hola, ¿venís a la charla de hoy?');
  });

  it('opens the post that has the mention', async () => {
    const mentioned = newAccount();
    await newDevice(mentioned);
    const mention = mentionOf(mentioned);
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(mention));

    expect(sent[0].message.data).toEqual({ type: 'mention', postId: mention.data.post_id });
  });

  it('adds the mention to the notification center of the mentioned account', async () => {
    const mentioned = newAccount();
    const mention = mentionOf(mentioned);

    await handler(fakePush().push)(JSON.stringify(mention));

    expect(await notifications().findOne({ _id: mention.id })).toEqual({
      _id: mention.id,
      recipient_id: mentioned,
      type: 'mention',
      actor_id: mention.data.author_id,
      actor_handle: 'juanperez',
      post_id: mention.data.post_id,
      reply_id: null,
      created_at: new Date(mention.time),
      read_at: null,
      deleted_at: null,
    });
  });

  it('pushes only to the devices of the mentioned account', async () => {
    const mentioned = newAccount();
    const phone = await newDevice(mentioned);
    await newDevice(newAccount());
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(mentionOf(mentioned)));

    expect(sent).toHaveLength(1);
    expect(sent[0].tokens).toEqual([phone]);
  });

  it('does not notify twice for the same event', async () => {
    const mentioned = newAccount();
    await newDevice(mentioned);
    const mention = mentionOf(mentioned);
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(mention));
    await expect(handler(push)(JSON.stringify(mention))).resolves.toBe('ack');

    expect(sent).toHaveLength(1);
    expect(await notifications().countDocuments({ _id: mention.id })).toBe(1);
  });

  it('keeps the mention in the center without a push when the account turned mentions off', async () => {
    const mentioned = newAccount();
    await newDevice(mentioned);
    await createPreferenceStore(preferences()).set(mentioned, { mention: false }, new Date());
    const mention = mentionOf(mentioned);
    const { push, sent } = fakePush();

    await expect(handler(push)(JSON.stringify(mention))).resolves.toBe('ack');

    expect(sent).toHaveLength(0);
    expect(await notifications().countDocuments({ _id: mention.id })).toBe(1);
  });
});

describe('a thread notifies once', () => {
  it('E4-H4.CA3 - a second mention in the same thread sends nothing', async () => {
    const mentioned = newAccount();
    await newDevice(mentioned);
    const author = newAccount();
    const thread = randomUUID();
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(inThread(mentionOf(mentioned), author, thread)));
    const second = inThread(mentionOf(mentioned), author, thread);
    await expect(handler(push)(JSON.stringify(second))).resolves.toBe('ack');

    expect(sent).toHaveLength(1);
    expect(await notifications().countDocuments({ recipient_id: mentioned })).toBe(1);
    expect(await notifications().countDocuments({ _id: second.id })).toBe(0);
  });

  it('E4-H4.CA3 - a mention in another thread is notified', async () => {
    const mentioned = newAccount();
    await newDevice(mentioned);
    const author = newAccount();
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(inThread(mentionOf(mentioned), author, randomUUID())));
    await handler(push)(JSON.stringify(inThread(mentionOf(mentioned), author, randomUUID())));

    expect(sent).toHaveLength(2);
    expect(await notifications().countDocuments({ recipient_id: mentioned })).toBe(2);
  });

  it('is notified when another author mentions the same account in that thread', async () => {
    const mentioned = newAccount();
    await newDevice(mentioned);
    const thread = randomUUID();
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(inThread(mentionOf(mentioned), newAccount(), thread)));
    await handler(push)(JSON.stringify(inThread(mentionOf(mentioned), newAccount(), thread)));

    expect(sent).toHaveLength(2);
  });

  it('is notified when the same author mentions another account in that thread', async () => {
    const [ana, beto] = [newAccount(), newAccount()];
    await newDevice(ana);
    await newDevice(beto);
    const author = newAccount();
    const thread = randomUUID();
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(inThread(mentionOf(ana), author, thread)));
    await handler(push)(JSON.stringify(inThread(mentionOf(beto), author, thread)));

    expect(sent).toHaveLength(2);
  });

  it('sends one push when two mentions of the same thread are handled at once', async () => {
    const mentioned = newAccount();
    await newDevice(mentioned);
    const author = newAccount();
    const thread = randomUUID();
    const { push, sent } = fakePush();

    await Promise.all([
      handler(push)(JSON.stringify(inThread(mentionOf(mentioned), author, thread))),
      handler(push)(JSON.stringify(inThread(mentionOf(mentioned), author, thread))),
    ]);

    expect(sent).toHaveLength(1);
    expect(await threads().countDocuments({ recipient_id: mentioned })).toBe(1);
  });

  it('finishes an event that came again after its record was written', async () => {
    const mentioned = newAccount();
    await newDevice(mentioned);
    const author = newAccount();
    const thread = randomUUID();
    const mention = inThread(mentionOf(mentioned), author, thread);
    // What is left when the handler stopped after the record and before the entry.
    await createMentionThreadStore(threads()).claim(
      { recipientId: mentioned, authorId: author, threadId: thread },
      mention.id,
      new Date(mention.time)
    );
    const { push, sent } = fakePush();

    await handler(push)(JSON.stringify(mention));

    expect(sent).toHaveLength(1);
    expect(await notifications().countDocuments({ _id: mention.id })).toBe(1);
  });
});
