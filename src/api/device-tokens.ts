import { Hono } from 'hono';

import { registerDeviceToken, type DeviceTokenStore } from '../app/device-tokens';
import type { AuthConfig } from '../config';
import { requireAccount, type AuthVariables } from './auth';

/**
 * Where the app hands over its FCM token after every login, mounted under
 * /api/notifications/device-tokens.
 */
export function deviceTokenRoutes({ auth, store }: { auth: AuthConfig; store: DeviceTokenStore }) {
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.post('/', requireAccount(auth), async (c) => {
    // A body that is not JSON is answered like one without a token.
    const body: unknown = await c.req.json().catch(() => undefined);
    await registerDeviceToken(store, c.get('accountId'), body, new Date());
    return c.body(null, 204);
  });

  return routes;
}
