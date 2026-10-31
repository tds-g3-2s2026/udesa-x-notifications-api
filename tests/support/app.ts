import { createApp, type AppDependencies } from '../../src/api/app';
import type { NotificationStore } from '../../src/app/notifications';
import { issueToken, TEST_AUTH } from './auth';

// A test that reaches the store without handing one in fails loudly.
const noStore = () => Promise.reject(new Error('This test passed no notification store'));
const NO_NOTIFICATIONS: NotificationStore = {
  add: noStore,
  page: noStore,
  markAllRead: noStore,
  softDelete: noStore,
  softDeleteOwnedBy: noStore,
};

/** The app with nothing to check, unless the test says otherwise. */
export function buildApp(dependencies: Partial<AppDependencies> = {}) {
  return createApp({
    healthChecks: [],
    auth: TEST_AUTH,
    notifications: NO_NOTIFICATIONS,
    ...dependencies,
  });
}

/** A request to the app as `account`, with a valid access token of it. */
export async function requestAs(
  app: ReturnType<typeof buildApp>,
  account: string,
  path: string,
  method = 'GET'
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${await issueToken({ sub: account })}` },
  });
}
