import { ProblemError } from './errors';

/**
 * One entry of an account's in-app history. It holds data, not text: the app
 * builds the sentence from `type` and `actor`, so the stored entry does not
 * depend on how the message is worded.
 */
export interface Notification {
  /** The id of the event that produced it, so the same event never adds two. */
  id: string;
  /** The account that sees it. */
  recipientId: string;
  /** `follow`, `like`, `retweet` or `reply` today. Open on purpose: new kinds only add values. */
  type: string;
  /** Who did it. The handle is copied from the event as it came, and may be null. */
  actor: { id: string; handle: string | null };
  /** The post it is about; null for a follow. */
  postId: string | null;
  /** The reply itself when `type` is `reply`; null otherwise. */
  replyId: string | null;
  createdAt: Date;
  /** Null while unread. */
  readAt: Date | null;
}

/** Where a page ended: the order column plus the id that breaks ties on it. */
export interface PagePosition {
  createdAt: Date;
  id: string;
}

/**
 * Nothing is ever removed from the store: a deleted notification gets a
 * `deleted_at` and every read leaves it out from then on.
 */
export interface NotificationStore {
  /**
   * Stores a new, unread notification and answers true. When the id is already
   * there nothing changes and it answers false: the same event came again.
   */
  add(notification: Omit<Notification, 'readAt'>): Promise<boolean>;
  /**
   * Up to `limit` notifications of the account that are not deleted, newest
   * first and, with `after`, strictly after that position.
   */
  page(recipientId: string, limit: number, after: PagePosition | null): Promise<Notification[]>;
  /** Marks as read, at `at`, every notification of the account still unread and not deleted. */
  markAllRead(recipientId: string, at: Date): Promise<void>;
  /**
   * Marks the notification deleted at `at`, unless it already was. Answers
   * whether the account has a notification with that id, deleted or not.
   */
  softDelete(recipientId: string, id: string, at: Date): Promise<boolean>;
  /**
   * Marks every notification of the account deleted at `at`, for when the
   * account is deleted. Those already deleted keep their date.
   */
  softDeleteOwnedBy(recipientId: string, at: Date): Promise<void>;
}

/** Fixed on purpose, the same size as every other listing of the system. */
export const PAGE_SIZE = 20;

export interface NotificationPage {
  items: Notification[];
  /** What the client sends back for the next page; null when there is none. */
  nextCursor: string | null;
}

const invalidCursor = () =>
  new ProblemError({
    status: 400,
    code: 'invalid-cursor',
    title: 'Cursor inválido',
    detail: 'El cursor no tiene un formato reconocible',
  });

/**
 * The cursor is opaque to the client: only this module reads it, so what it
 * holds can change without breaking an app that just echoes it back.
 */
export function encodeCursor({ createdAt, id }: PagePosition): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): PagePosition {
  // Decoding base64url skips characters outside its alphabet instead of
  // failing, so the date is checked to survive the round trip intact.
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  const id = raw.slice(separator + 1);
  const createdAt = new Date(raw.slice(0, separator));
  if (
    separator === -1 ||
    id === '' ||
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== raw.slice(0, separator)
  ) {
    throw invalidCursor();
  }
  return { createdAt, id };
}

/**
 * One page of the account's notifications. One more than a page is read, so
 * the last page answers `nextCursor: null` instead of making the app ask for
 * an empty one.
 */
export async function listNotifications(
  store: NotificationStore,
  recipientId: string,
  cursor: string | undefined
): Promise<NotificationPage> {
  const after = cursor === undefined ? null : decodeCursor(cursor);
  const found = await store.page(recipientId, PAGE_SIZE + 1, after);
  const items = found.slice(0, PAGE_SIZE);
  const last = items.at(-1);
  return {
    items,
    nextCursor: found.length > PAGE_SIZE && last ? encodeCursor(last) : null,
  };
}

/**
 * Deletes one notification of the account, logically. Deleting it again is
 * not an error, so a retried swipe gets the same answer. Somebody else's and a
 * missing one get the same 404, so the answer never tells that an id exists.
 */
export async function deleteNotification(
  store: NotificationStore,
  recipientId: string,
  id: string,
  at: Date
): Promise<void> {
  if (!(await store.softDelete(recipientId, id, at))) {
    throw new ProblemError({
      status: 404,
      code: 'notification-not-found',
      title: 'Notificación inexistente',
      detail: 'No existe ninguna notificación con ese id',
    });
  }
}
