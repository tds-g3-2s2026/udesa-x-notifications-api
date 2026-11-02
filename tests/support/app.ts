import { createApp, type AppDependencies } from '../../src/api/app';
import type { DeviceTokenStore } from '../../src/app/device-tokens';
import type { NotificationStore } from '../../src/app/notifications';
import { issueToken, TEST_AUTH } from './auth';

// A test that reaches a store without handing one in fails loudly.
const noStore = (what: string) => () =>
  Promise.reject(new Error(`This test passed no ${what} store`));
const NO_NOTIFICATIONS: NotificationStore = {
  add: noStore('notification'),
  page: noStore('notification'),
  markAllRead: noStore('notification'),
  softDelete: noStore('notification'),
  softDeleteOwnedBy: noStore('notification'),
};
const NO_DEVICE_TOKENS: DeviceTokenStore = {
  register: noStore('device token'),
  activeTokensOf: noStore('device token'),
  softDelete: noStore('device token'),
  softDeleteOwnedBy: noStore('device token'),
};

/** The app with nothing to check, unless the test says otherwise. */
export function buildApp(dependencies: Partial<AppDependencies> = {}) {
  return createApp({
    healthChecks: [],
    auth: TEST_AUTH,
    notifications: NO_NOTIFICATIONS,
    deviceTokens: NO_DEVICE_TOKENS,
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
