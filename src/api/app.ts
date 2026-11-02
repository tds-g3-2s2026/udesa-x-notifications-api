import { Hono } from 'hono';

import { version } from '../../package.json';
import type { DeviceTokenStore } from '../app/device-tokens';
import type { NotificationStore } from '../app/notifications';
import type { AuthConfig } from '../config';
import { buildReport, type DependencyCheck } from '../infrastructure/health';
import { requestTelemetry } from '../infrastructure/telemetry';
import { deviceTokenRoutes } from './device-tokens';
import { notFound, onError } from './errors';
import { notificationRoutes } from './notifications';

export interface AppDependencies {
  /** What /healthcheck looks at: MongoDB and RabbitMQ in production. */
  healthChecks: DependencyCheck[];
  /** How the routes under /api tell a real access token from a forged one. */
  auth: AuthConfig;
  notifications: NotificationStore;
  deviceTokens: DeviceTokenStore;
}

/**
 * Builds the HTTP app from what index.ts hands it. Nothing in here knows a
 * concrete MongoDB or RabbitMQ client: the tests pass their own.
 */
export function createApp({ healthChecks, auth, notifications, deviceTokens }: AppDependencies) {
  const app = new Hono();

  app.use(requestTelemetry);
  app.onError(onError);
  app.notFound(notFound);

  // Readiness: 503 pulls the pod out of rotation while a dependency is down.
  // Outside the Problem Details format on purpose (ARQUITECTURA.md).
  app.get('/healthcheck', async (c) => {
    const report = await buildReport(healthChecks);
    return c.json({ ...report, version }, report.status === 'ok' ? 200 : 503);
  });

  // Liveness: no dependency, so a broker outage never restarts the pod.
  app.get('/livez', (c) => c.json({ status: 'ok' }));

  // What the app calls, through the gateway's /api/notifications prefix.
  app.route('/api/notifications', notificationRoutes({ auth, store: notifications }));
  app.route('/api/notifications/device-tokens', deviceTokenRoutes({ auth, store: deviceTokens }));

  return app;
}
