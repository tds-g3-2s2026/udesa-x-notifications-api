import { Hono } from 'hono';

import {
  deleteNotification,
  listNotifications,
  type Notification,
  type NotificationStore,
} from '../app/notifications';
import type { AuthConfig } from '../config';
import { requireAccount, type AuthVariables } from './auth';

// camelCase like every paginated listing of the system. The recipient is left
// out: it is always the caller.
function toItem(notification: Notification) {
  return {
    id: notification.id,
    type: notification.type,
    actor: notification.actor,
    postId: notification.postId,
    replyId: notification.replyId,
    createdAt: notification.createdAt.toISOString(),
    readAt: notification.readAt?.toISOString() ?? null,
  };
}

/**
 * The in-app notification center, mounted under /api/notifications. Every
 * route works on the account of the token, never on one the client names.
 */
export function notificationRoutes({
  auth,
  store,
}: {
  auth: AuthConfig;
  store: NotificationStore;
}) {
  const routes = new Hono<{ Variables: AuthVariables }>();
  // Per route and not with `use`: other routers share this prefix, and their
  // routes are not this one's to guard.
  const account = requireAccount(auth);

  routes.get('/', account, async (c) => {
    const page = await listNotifications(store, c.get('accountId'), c.req.query('cursor'));
    return c.json({ items: page.items.map(toItem), nextCursor: page.nextCursor });
  });

  routes.post('/read-all', account, async (c) => {
    await store.markAllRead(c.get('accountId'), new Date());
    return c.body(null, 204);
  });

  routes.delete('/:id', account, async (c) => {
    await deleteNotification(store, c.get('accountId'), c.req.param('id'), new Date());
    return c.body(null, 204);
  });

  return routes;
}
