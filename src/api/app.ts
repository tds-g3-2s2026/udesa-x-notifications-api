import { Hono } from 'hono';

import { version } from '../../package.json';
import { buildReport, type DependencyCheck } from '../infrastructure/health';
import { requestTelemetry } from '../infrastructure/telemetry';
import { notFound, onError } from './errors';

export interface AppDependencies {
  /** What /healthcheck looks at: MongoDB and RabbitMQ in production. */
  healthChecks: DependencyCheck[];
}

/**
 * Builds the HTTP app from what index.ts hands it. Nothing in here knows a
 * concrete MongoDB or RabbitMQ client: the tests pass their own.
 */
export function createApp({ healthChecks }: AppDependencies) {
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

  return app;
}
