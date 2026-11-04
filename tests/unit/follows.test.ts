import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceTokenStore } from '../../src/app/device-tokens';
import { createFollowCreatedHandler } from '../../src/app/follows';
import type { NotificationStore } from '../../src/app/notifications';
import type { PushSender } from '../../src/app/push';
import { exampleEvent } from '../support/contracts';

const NOW = new Date('2026-11-02T12:00:00Z');

function setup({ tokens = ['phone', 'tablet'], isNew = true, invalid = [] as string[] } = {}) {
  const calls: string[] = [];
  const deviceTokens = {
    register: vi.fn(),
    activeTokensOf: vi.fn<DeviceTokenStore['activeTokensOf']>(async () => {
      calls.push('tokens');
      return tokens;
    }),
    softDelete: vi.fn<DeviceTokenStore['softDelete']>(async () => {}),
    softDeleteOwnedBy: vi.fn(),
  } satisfies DeviceTokenStore;
  const notifications = {
    add: vi.fn<NotificationStore['add']>(async () => {
      calls.push('entry');
      return isNew;
    }),
    page: vi.fn(),
    markAllRead: vi.fn(),
    softDelete: vi.fn(),
    softDeleteOwnedBy: vi.fn(),
  } satisfies NotificationStore;
  const push = {
    send: vi.fn<PushSender['send']>(async () => {
      calls.push('push');
      return { invalidTokens: invalid };
    }),
  } satisfies PushSender;
  const handle = createFollowCreatedHandler({ notifications, deviceTokens, push, now: () => NOW });
  return { handle, deviceTokens, notifications, push, calls };
}

const event = () => exampleEvent('follow.created.v1');

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('follow.created handler', () => {
  it('adds the entry to the center of the followed account and pushes to its devices', async () => {
    const { handle, deviceTokens, notifications, push } = setup();
    const follow = event();

    await expect(handle(JSON.stringify(follow))).resolves.toBe('ack');

    expect(deviceTokens.activeTokensOf).toHaveBeenCalledWith(follow.data.followee_id);
    expect(notifications.add).toHaveBeenCalledWith({
      id: follow.id,
      recipientId: follow.data.followee_id,
      type: 'follow',
      actor: { id: follow.data.follower_id, handle: 'juanperez' },
      postId: null,
      replyId: null,
      createdAt: new Date(follow.time),
    });
    expect(push.send).toHaveBeenCalledWith(['phone', 'tablet'], {
      title: 'Nuevo seguidor',
      body: '@juanperez te empezó a seguir',
      data: { type: 'follow', actorId: follow.data.follower_id },
    });
  });

  it('reads the tokens before adding the entry, and pushes last', async () => {
    const { handle, calls } = setup();

    await handle(JSON.stringify(event()));

    // A failed read then requeues with nothing done, and the push only goes
    // out once the entry says the event is handled.
    expect(calls).toEqual(['tokens', 'entry', 'push']);
  });

  it('says who followed without a handle when posts-api did not know it', async () => {
    const { handle, notifications, push } = setup();
    const follow = event();

    await handle(JSON.stringify({ ...follow, data: { ...follow.data, follower_handle: null } }));

    expect(notifications.add).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { id: follow.data.follower_id, handle: null } })
    );
    expect(push.send).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ body: 'Alguien te empezó a seguir' })
    );
  });

  it('works with the account ids in lowercase, the way requireAccount stores them', async () => {
    const { handle, deviceTokens, notifications, push } = setup();
    const follow = event();
    const upper = {
      ...follow,
      data: {
        ...follow.data,
        follower_id: follow.data.follower_id.toUpperCase(),
        followee_id: follow.data.followee_id.toUpperCase(),
      },
    };

    await handle(JSON.stringify(upper));

    expect(deviceTokens.activeTokensOf).toHaveBeenCalledWith(follow.data.followee_id);
    expect(notifications.add).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: follow.data.followee_id })
    );
    expect(push.send.mock.calls[0][1].data.actorId).toBe(follow.data.follower_id);
  });

  it('sends nothing for an event it already handled', async () => {
    const { handle, push } = setup({ isNew: false });

    await expect(handle(JSON.stringify(event()))).resolves.toBe('ack');

    expect(push.send).not.toHaveBeenCalled();
  });

  it('keeps the entry and sends nothing when the account has no device', async () => {
    const { handle, notifications, push } = setup({ tokens: [] });

    await expect(handle(JSON.stringify(event()))).resolves.toBe('ack');

    expect(notifications.add).toHaveBeenCalledOnce();
    expect(push.send).not.toHaveBeenCalled();
  });

  it('E4-H1.CA4 marks deleted the tokens FCM says no longer exist, and only those', async () => {
    const { handle, deviceTokens } = setup({ invalid: ['tablet'] });

    await expect(handle(JSON.stringify(event()))).resolves.toBe('ack');

    expect(deviceTokens.softDelete).toHaveBeenCalledExactlyOnceWith(['tablet'], NOW);
  });

  it('touches no token when FCM reported none gone', async () => {
    const { handle, deviceTokens } = setup();

    await handle(JSON.stringify(event()));

    expect(deviceTokens.softDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('MongoDB is down'), 'MongoDB is down'],
    ['something else', 'connection reset', 'unknown error'],
  ])(
    'acks and logs when marking the gone tokens fails with %s: the next push reports them again',
    async (_, failure, logged) => {
      const { handle, deviceTokens } = setup({ invalid: ['tablet'] });
      deviceTokens.softDelete.mockRejectedValueOnce(failure);
      const follow = event();

      await expect(handle(JSON.stringify(follow))).resolves.toBe('ack');

      expect(console.warn).toHaveBeenCalledWith('Could not soft-delete invalid device tokens', {
        id: follow.id,
        error: logged,
      });
    }
  );

  it('acks and logs when the push cannot go out, without retrying', async () => {
    const { handle, deviceTokens, push } = setup();
    push.send.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND fcm.googleapis.com'));
    const follow = event();

    await expect(handle(JSON.stringify(follow))).resolves.toBe('ack');

    expect(console.warn).toHaveBeenCalledWith('Push not sent', {
      id: follow.id,
      type: 'follow.created.v1',
      error: 'getaddrinfo ENOTFOUND fcm.googleapis.com',
    });
    expect(deviceTokens.softDelete).not.toHaveBeenCalled();
  });

  it('throws, so the message is requeued, and adds nothing when the tokens cannot be read', async () => {
    const { handle, deviceTokens, notifications } = setup();
    deviceTokens.activeTokensOf.mockRejectedValueOnce(new Error('MongoDB is down'));

    await expect(handle(JSON.stringify(event()))).rejects.toThrow('MongoDB is down');

    expect(notifications.add).not.toHaveBeenCalled();
  });

  it('throws and pushes nothing when the entry cannot be added', async () => {
    const { handle, notifications, push } = setup();
    notifications.add.mockRejectedValueOnce(new Error('MongoDB is down'));

    await expect(handle(JSON.stringify(event()))).rejects.toThrow('MongoDB is down');

    expect(push.send).not.toHaveBeenCalled();
  });

  it('acks and logs a push sender that rejects with something that is not an Error', async () => {
    const { handle, push } = setup();
    push.send.mockRejectedValueOnce('socket hang up');
    const follow = event();

    await expect(handle(JSON.stringify(follow))).resolves.toBe('ack');

    expect(console.warn).toHaveBeenCalledWith('Push not sent', {
      id: follow.id,
      type: 'follow.created.v1',
      error: 'unknown error',
    });
  });

  it.each([
    ['invalid JSON', () => '{nope', 'body is not valid JSON'],
    ['no id', () => JSON.stringify({ ...event(), id: '' }), 'missing id'],
    [
      'another type',
      () => JSON.stringify({ ...event(), type: 'user.deleted.v1' }),
      'not a follow.created.v1 event',
    ],
    ['no time', () => JSON.stringify({ ...event(), time: undefined }), 'missing time'],
    ['a time that is no date', () => JSON.stringify({ ...event(), time: 'ayer' }), 'missing time'],
    ['no data', () => JSON.stringify({ ...event(), data: null }), 'missing data.follower_id'],
    [
      'no followee',
      () => JSON.stringify({ ...event(), data: { ...event().data, followee_id: undefined } }),
      'missing data.followee_id',
    ],
  ])('sends to the DLQ an event with %s, touching nothing', async (_, body, reason) => {
    const { handle, deviceTokens, notifications, push } = setup();

    await expect(handle(body())).resolves.toBe('dead-letter');

    expect(console.warn).toHaveBeenCalledWith('Discarding event that cannot be handled', {
      reason,
      type: 'follow.created.v1',
    });
    expect(deviceTokens.activeTokensOf).not.toHaveBeenCalled();
    expect(notifications.add).not.toHaveBeenCalled();
    expect(push.send).not.toHaveBeenCalled();
  });
});
