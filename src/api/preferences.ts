import { Hono } from 'hono';

import { getPreferences, updatePreferences, type PreferenceStore } from '../app/preferences';
import type { AuthConfig } from '../config';
import { requireAccount, type AuthVariables } from './auth';

/**
 * Which kinds of notification the account wants, mounted under
 * /api/notifications/preferences. The answer is one boolean per type, named
 * like the `type` of a notification.
 */
export function preferenceRoutes({ auth, store }: { auth: AuthConfig; store: PreferenceStore }) {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const account = requireAccount(auth);

  routes.get('/', account, async (c) => c.json(await getPreferences(store, c.get('accountId'))));

  routes.put('/', account, async (c) => {
    // A body that is not JSON is answered like one with a wrong field.
    const body: unknown = await c.req.json().catch(() => undefined);
    return c.json(await updatePreferences(store, c.get('accountId'), body, new Date()));
  });

  return routes;
}
