import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Notification, NotificationStore } from '../../src/app/notifications';
import { buildApp, requestAs } from '../support/app';
import { aNotification } from '../support/notifications';

// The HTTP side only, with the store as a double. What the store does with
// MongoDB is in tests/integration.
function fakeStore(found: Notification[] = [], { owned = true } = {}) {
  return {
    add: vi.fn(),
    page: vi.fn<NotificationStore['page']>(async () => found),
    markAllRead: vi.fn<NotificationStore['markAllRead']>(async () => {}),
    softDelete: vi.fn<NotificationStore['softDelete']>(async () => owned),
    softDeleteOwnedBy: vi.fn(),
  } satisfies NotificationStore;
}

function call(
  store: NotificationStore,
  path: string,
  { account = randomUUID(), method = 'GET' } = {}
) {
  return requestAs(buildApp({ notifications: store }), account, path, method);
}

describe('GET /api/notifications', () => {
  it('lists the notifications of the account in the token', async () => {
    const store = fakeStore();
    const account = randomUUID();

    const res = await call(store, '/api/notifications', { account });

    expect(res.status).toBe(200);
    expect(store.page).toHaveBeenCalledWith(account, 21, null);
  });

  it('answers each item in camelCase, without the recipient', async () => {
    const account = randomUUID();
    const like = { ...aNotification(account), readAt: null };
    const reply = {
      ...aNotification(account, { type: 'reply', replyId: randomUUID() }),
      actor: { id: randomUUID(), handle: null },
      readAt: new Date('2026-10-24T09:00:00.000Z'),
    };

    const res = await call(fakeStore([like, reply]), '/api/notifications', { account });

    expect(await res.json()).toEqual({
      items: [
        {
          id: like.id,
          type: 'like',
          actor: like.actor,
          postId: like.postId,
          replyId: null,
          createdAt: '2026-10-23T14:07:30.000Z',
          readAt: null,
        },
        {
          id: reply.id,
          type: 'reply',
          actor: { id: reply.actor.id, handle: null },
          postId: reply.postId,
          replyId: reply.replyId,
          createdAt: '2026-10-23T14:07:30.000Z',
          readAt: '2026-10-24T09:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it('answers 400 invalid-cursor in Problem Details for a cursor it did not issue', async () => {
    const res = await call(fakeStore(), '/api/notifications?cursor=not-a-cursor');

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await res.json()).toMatchObject({
      type: 'https://udesa-x.dev/errors/invalid-cursor',
      status: 400,
    });
  });

  it('answers 401 invalid-token without a token, before reaching the store', async () => {
    const store = fakeStore();

    const res = await buildApp({ notifications: store }).request('/api/notifications');

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'https://udesa-x.dev/errors/invalid-token' });
    expect(store.page).not.toHaveBeenCalled();
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks every notification of the account read and answers 204 with no body', async () => {
    const store = fakeStore();
    const account = randomUUID();

    const res = await call(store, '/api/notifications/read-all', { account, method: 'POST' });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(store.markAllRead).toHaveBeenCalledWith(account, expect.any(Date));
  });

  it('answers 401 without a token, marking nothing', async () => {
    const store = fakeStore();

    const res = await buildApp({ notifications: store }).request('/api/notifications/read-all', {
      method: 'POST',
    });

    expect(res.status).toBe(401);
    expect(store.markAllRead).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('soft-deletes the notification of the account and answers 204 with no body', async () => {
    const store = fakeStore();
    const account = randomUUID();
    const id = randomUUID();

    const res = await call(store, `/api/notifications/${id}`, { account, method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(store.softDelete).toHaveBeenCalledWith(account, id, expect.any(Date));
  });

  it('answers 404 notification-not-found in Problem Details when the account has none', async () => {
    const res = await call(fakeStore([], { owned: false }), '/api/notifications/abc', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await res.json()).toMatchObject({
      type: 'https://udesa-x.dev/errors/notification-not-found',
      status: 404,
      instance: '/api/notifications/abc',
    });
  });

  it('answers 401 without a token, deleting nothing', async () => {
    const store = fakeStore();

    const res = await buildApp({ notifications: store }).request(
      `/api/notifications/${randomUUID()}`,
      { method: 'DELETE' }
    );

    expect(res.status).toBe(401);
    expect(store.softDelete).not.toHaveBeenCalled();
  });
});
