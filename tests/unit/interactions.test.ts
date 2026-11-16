import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceTokenStore } from '../../src/app/device-tokens';
import { createInteractionCreatedHandler } from '../../src/app/interactions';
import type { NotificationStore } from '../../src/app/notifications';
import type { PushSender } from '../../src/app/push';
import { exampleEvent, type EventEnvelope } from '../support/contracts';

function setup({ isNew = true } = {}) {
  const deviceTokens = {
    register: vi.fn(),
    activeTokensOf: vi.fn<DeviceTokenStore['activeTokensOf']>(async () => ['phone']),
    softDelete: vi.fn<DeviceTokenStore['softDelete']>(async () => {}),
    softDeleteOwnedBy: vi.fn(),
  } satisfies DeviceTokenStore;
  const notifications = {
    add: vi.fn<NotificationStore['add']>(async () => isNew),
    page: vi.fn(),
    markAllRead: vi.fn(),
    softDelete: vi.fn(),
    softDeleteOwnedBy: vi.fn(),
  } satisfies NotificationStore;
  const push = {
    send: vi.fn<PushSender['send']>(async () => ({ invalidTokens: [] })),
  } satisfies PushSender;
  const handle = createInteractionCreatedHandler({ notifications, deviceTokens, push });
  return { handle, deviceTokens, notifications, push };
}

/** The like of the schema's first example, or another kind of the same interaction. */
function event(kind = 'like'): EventEnvelope {
  const interaction = exampleEvent('interaction.created.v1');
  interaction.data.kind = kind;
  if (kind === 'reply') {
    interaction.data.reply_id = randomUUID();
  }
  return interaction;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('interaction.created handler', () => {
  it.each([
    ['like', 'Nuevo me gusta', '@juanperez le dio me gusta a tu publicación'],
    ['retweet', 'Nuevo retweet', '@juanperez retuiteó tu publicación'],
    ['reply', 'Nueva respuesta', '@juanperez respondió tu publicación'],
  ])('E4-H2.CA1 a %s push says what happened and who did it', async (kind, title, body) => {
    const { handle, deviceTokens, push } = setup();
    const interaction = event(kind);

    await expect(handle(JSON.stringify(interaction))).resolves.toBe('ack');

    expect(deviceTokens.activeTokensOf).toHaveBeenCalledWith(interaction.data.post_author_id);
    expect(push.send).toHaveBeenCalledWith(['phone'], expect.objectContaining({ title, body }));
  });

  it.each(['like', 'retweet', 'reply'])(
    'E4-H2.CA2 a %s push carries the post the app opens',
    async (kind) => {
      const { handle, push } = setup();
      const interaction = event(kind);

      await handle(JSON.stringify(interaction));

      // For a reply too it is the answered post, not the reply.
      expect(push.send.mock.calls[0][1].data).toEqual({
        type: kind,
        postId: interaction.data.post_id,
      });
    }
  );

  it('adds the entry to the center of the post author, with the reply that answered it', async () => {
    const { handle, notifications } = setup();
    const reply = event('reply');

    await handle(JSON.stringify(reply));

    expect(notifications.add).toHaveBeenCalledWith({
      id: reply.id,
      recipientId: reply.data.post_author_id,
      type: 'reply',
      actor: { id: reply.data.actor_id, handle: 'juanperez' },
      postId: reply.data.post_id,
      replyId: reply.data.reply_id,
      createdAt: new Date(reply.time),
    });
  });

  it('says who did it without a handle when posts-api did not know it', async () => {
    const { handle, notifications, push } = setup();
    const like = event();

    await handle(JSON.stringify({ ...like, data: { ...like.data, actor_handle: null } }));

    expect(notifications.add).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { id: like.data.actor_id, handle: null } })
    );
    expect(push.send).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ body: 'Alguien le dio me gusta a tu publicación' })
    );
  });

  it('does not double the @ of a handle that already carries it, as users-api handles do', async () => {
    const { handle, push } = setup();
    const like = event();

    await handle(JSON.stringify({ ...like, data: { ...like.data, actor_handle: '@ana' } }));

    expect(push.send).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ body: '@ana le dio me gusta a tu publicación' })
    );
  });

  it('works with the account ids in lowercase, the way requireAccount stores them', async () => {
    const { handle, deviceTokens, notifications } = setup();
    const like = event();
    const upper = {
      ...like,
      data: {
        ...like.data,
        actor_id: like.data.actor_id.toUpperCase(),
        post_author_id: like.data.post_author_id.toUpperCase(),
      },
    };

    await handle(JSON.stringify(upper));

    expect(deviceTokens.activeTokensOf).toHaveBeenCalledWith(like.data.post_author_id);
    expect(notifications.add).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: like.data.post_author_id,
        actor: { id: like.data.actor_id, handle: 'juanperez' },
      })
    );
  });

  it('sends nothing for an event it already handled', async () => {
    const { handle, push } = setup({ isNew: false });

    await expect(handle(JSON.stringify(event()))).resolves.toBe('ack');

    expect(push.send).not.toHaveBeenCalled();
  });

  it.each(['quote', 'constructor'])(
    'acks a kind it does not know (%s), touching nothing: the contract says to ignore it',
    async (kind) => {
      const { handle, deviceTokens, notifications, push } = setup();
      const unknown = event(kind);

      await expect(handle(JSON.stringify(unknown))).resolves.toBe('ack');

      expect(console.info).toHaveBeenCalledWith('Interaction kind not handled', {
        id: unknown.id,
        kind,
      });
      expect(deviceTokens.activeTokensOf).not.toHaveBeenCalled();
      expect(notifications.add).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['invalid JSON', () => '{nope', 'body is not valid JSON'],
    ['no id', () => JSON.stringify({ ...event(), id: '' }), 'missing id'],
    [
      'another type',
      () => JSON.stringify({ ...event(), type: 'follow.created.v1' }),
      'not an interaction.created.v1 event',
    ],
    ['no time', () => JSON.stringify({ ...event(), time: undefined }), 'missing time'],
    ['no data', () => JSON.stringify({ ...event(), data: null }), 'missing data.kind'],
    [
      'no actor',
      () => JSON.stringify({ ...event(), data: { ...event().data, actor_id: undefined } }),
      'missing data.actor_id',
    ],
    [
      'no post',
      () => JSON.stringify({ ...event(), data: { ...event().data, post_id: undefined } }),
      'missing data.post_id',
    ],
    [
      'no post author',
      () => JSON.stringify({ ...event(), data: { ...event().data, post_author_id: undefined } }),
      'missing data.post_author_id',
    ],
  ])('sends to the DLQ an event with %s, touching nothing', async (_, body, reason) => {
    const { handle, deviceTokens, notifications, push } = setup();

    await expect(handle(body())).resolves.toBe('dead-letter');

    expect(console.warn).toHaveBeenCalledWith('Discarding event that cannot be handled', {
      reason,
      type: 'interaction.created.v1',
    });
    expect(deviceTokens.activeTokensOf).not.toHaveBeenCalled();
    expect(notifications.add).not.toHaveBeenCalled();
    expect(push.send).not.toHaveBeenCalled();
  });
});
