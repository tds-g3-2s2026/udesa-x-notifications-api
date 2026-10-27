import { createApp, type AppDependencies } from '../../src/api/app';

/** The app with nothing to check, unless the test says otherwise. */
export function buildApp(dependencies: Partial<AppDependencies> = {}) {
  return createApp({ healthChecks: [], ...dependencies });
}
