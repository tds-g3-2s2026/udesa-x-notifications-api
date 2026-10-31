import { randomUUID } from 'node:crypto';

import type { Notification } from '../../src/app/notifications';

/** An unread like on a post, for `recipientId`, unless the test says otherwise. */
export function aNotification(
  recipientId: string,
  overrides: Partial<Omit<Notification, 'readAt'>> = {}
): Omit<Notification, 'readAt'> {
  return {
    id: randomUUID(),
    recipientId,
    type: 'like',
    actor: { id: randomUUID(), handle: 'juanperez' },
    postId: randomUUID(),
    replyId: null,
    createdAt: new Date('2026-10-23T14:07:30.000Z'),
    ...overrides,
  };
}
