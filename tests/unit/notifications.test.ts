import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ProblemError } from '../../src/app/errors';
import {
  decodeCursor,
  deleteNotification,
  encodeCursor,
  listNotifications,
  PAGE_SIZE,
  type Notification,
  type NotificationStore,
} from '../../src/app/notifications';
import { aNotification } from '../support/notifications';

const ACCOUNT = randomUUID();

function unread(count: number): Notification[] {
  return Array.from({ length: count }, (_, i) => ({
    ...aNotification(ACCOUNT, { createdAt: new Date(Date.UTC(2026, 9, 23, 12, 0, 60 - i)) }),
    readAt: null,
  }));
}

function storeReturning(found: Notification[], { owned = true } = {}) {
  const page = vi.fn<NotificationStore['page']>(async () => found);
  const softDelete = vi.fn<NotificationStore['softDelete']>(async () => owned);
  const store: NotificationStore = {
    add: vi.fn(),
    page,
    markAllRead: vi.fn(),
    softDelete,
    softDeleteOwnedBy: vi.fn(),
  };
  return { store, page, softDelete };
}

describe('cursor', () => {
  it('decodes back to the position it was made from', () => {
    const position = { createdAt: new Date('2026-10-23T14:07:30.123Z'), id: randomUUID() };

    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('is url safe, so the app can put it in the query string as is', () => {
    const cursor = encodeCursor({ createdAt: new Date(), id: '>>>???' });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 at all', '%%%'],
    ['no separator', Buffer.from('2026-10-23T14:07:30.000Z').toString('base64url')],
    ['no id', Buffer.from('2026-10-23T14:07:30.000Z|').toString('base64url')],
    ['not a date', Buffer.from('yesterday|abc').toString('base64url')],
    ['a date in another format', Buffer.from('2026-10-23|abc').toString('base64url')],
    ['empty', ''],
  ])('is refused with 400 invalid-cursor when it has %s', (_, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(
      expect.objectContaining({ status: 400, code: 'invalid-cursor' })
    );
  });
});

describe('listNotifications', () => {
  it('asks the store for one more than a page, from the start without a cursor', async () => {
    const { store, page } = storeReturning([]);

    await listNotifications(store, ACCOUNT, undefined);

    expect(page).toHaveBeenCalledWith(ACCOUNT, PAGE_SIZE + 1, null);
  });

  it('asks for what comes after the position in the cursor', async () => {
    const { store, page } = storeReturning([]);
    const position = { createdAt: new Date('2026-10-23T14:07:30.000Z'), id: randomUUID() };

    await listNotifications(store, ACCOUNT, encodeCursor(position));

    expect(page).toHaveBeenCalledWith(ACCOUNT, PAGE_SIZE + 1, position);
  });

  it('answers 20 and a cursor pointing at the 20th when there are more', async () => {
    const found = unread(PAGE_SIZE + 1);
    const { store } = storeReturning(found);

    const result = await listNotifications(store, ACCOUNT, undefined);

    expect(result.items).toEqual(found.slice(0, PAGE_SIZE));
    expect(result.nextCursor).not.toBeNull();
    expect(decodeCursor(result.nextCursor!)).toEqual({
      createdAt: found[PAGE_SIZE - 1].createdAt,
      id: found[PAGE_SIZE - 1].id,
    });
  });

  it('answers a null cursor on the last page, also when it is exactly full', async () => {
    const { store } = storeReturning(unread(PAGE_SIZE));

    const result = await listNotifications(store, ACCOUNT, undefined);

    expect(result.items).toHaveLength(PAGE_SIZE);
    expect(result.nextCursor).toBeNull();
  });

  it('answers an empty page for an account with nothing', async () => {
    const { store } = storeReturning([]);

    expect(await listNotifications(store, ACCOUNT, undefined)).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('does not reach the store with a broken cursor', async () => {
    const { store, page } = storeReturning([]);

    await expect(listNotifications(store, ACCOUNT, 'broken')).rejects.toBeInstanceOf(ProblemError);
    expect(page).not.toHaveBeenCalled();
  });
});

describe('deleteNotification', () => {
  it('soft-deletes the notification of the account at the given instant', async () => {
    const { store, softDelete } = storeReturning([]);
    const id = randomUUID();
    const at = new Date('2026-10-24T09:00:00.000Z');

    await deleteNotification(store, ACCOUNT, id, at);

    expect(softDelete).toHaveBeenCalledWith(ACCOUNT, id, at);
  });

  it('answers 404 notification-not-found when the account has none with that id', async () => {
    const { store } = storeReturning([], { owned: false });

    await expect(deleteNotification(store, ACCOUNT, randomUUID(), new Date())).rejects.toThrow(
      expect.objectContaining({ status: 404, code: 'notification-not-found' })
    );
  });
});
