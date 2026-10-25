import { createApp, type AppDependencies } from '../../src/api/app';
import type { DeviceTokenStore } from '../../src/app/device-tokens';
import { TEST_AUTH } from './auth';

export interface Registration {
  token: string;
  accountId: string;
  at: Date;
}

/** A store that only remembers what it was asked to register. */
export function recordingStore(): DeviceTokenStore & { registered: Registration[] } {
  const registered: Registration[] = [];
  return {
    registered,
    async register(token, accountId, at) {
      registered.push({ token, accountId, at });
    },
  };
}

/** The app with nothing to check and nowhere real to store, unless the test says otherwise. */
export function buildApp(dependencies: Partial<AppDependencies> = {}) {
  return createApp({
    healthChecks: [],
    auth: TEST_AUTH,
    deviceTokens: recordingStore(),
    ...dependencies,
  });
}
