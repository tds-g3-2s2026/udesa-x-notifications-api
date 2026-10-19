import { afterEach, describe, expect, it, vi } from 'vitest';

import { version } from '../../package.json';
import { createApp } from '../../src/api/app';
import { ProblemError } from '../../src/app/errors';
import type { DependencyCheck } from '../../src/infrastructure/health';

const up = (name: string): DependencyCheck => ({ name, check: async () => {} });
const down = (name: string, reason: string): DependencyCheck => ({
  name,
  check: async () => {
    throw new Error(reason);
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /healthcheck', () => {
  it('answers 200 with every dependency ok and the running version', async () => {
    const app = createApp({ healthChecks: [up('mongodb'), up('rabbitmq')] });

    const res = await app.request('/healthcheck');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      version,
      dependencies: { mongodb: 'ok', rabbitmq: 'ok' },
    });
  });

  it('answers 503 degraded with the reason of the dependency that is down', async () => {
    const app = createApp({
      healthChecks: [up('mongodb'), down('rabbitmq', 'connect ECONNREFUSED 127.0.0.1:5672')],
    });

    const res = await app.request('/healthcheck');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'degraded',
      version,
      dependencies: { mongodb: 'ok', rabbitmq: 'connect ECONNREFUSED 127.0.0.1:5672' },
    });
  });
});

describe('GET /livez', () => {
  it('stays 200 while a dependency is down, so the pod is not restarted', async () => {
    const app = createApp({ healthChecks: [down('rabbitmq', 'gone')] });

    const res = await app.request('/livez');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('error responses', () => {
  it('turn a ProblemError into Problem Details, with its status and headers', async () => {
    const app = createApp({ healthChecks: [] });
    app.get('/limited', () => {
      throw new ProblemError({
        status: 429,
        code: 'too-many-requests',
        title: 'Demasiadas solicitudes',
        detail: 'Probá más tarde',
        headers: { 'Retry-After': '30' },
      });
    });

    const res = await app.request('/limited');

    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toEqual({
      type: 'https://udesa-x.dev/errors/too-many-requests',
      title: 'Demasiadas solicitudes',
      status: 429,
      detail: 'Probá más tarde',
      instance: '/limited',
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it('answer an unexpected error with a generic 500 that leaks nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({ healthChecks: [] });
    app.get('/broken', () => {
      throw new Error('connection refused to mongodb.internal:27017');
    });

    const res = await app.request('/broken');
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(JSON.parse(text)).toMatchObject({
      type: 'https://udesa-x.dev/errors/internal-error',
      status: 500,
      instance: '/broken',
    });
    expect(text).not.toContain('mongodb.internal');
  });

  it('answer an unknown route with a 404 in Problem Details', async () => {
    const app = createApp({ healthChecks: [] });

    const res = await app.request('/api/nothing-here');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await res.json()).toMatchObject({
      type: 'https://udesa-x.dev/errors/route-not-found',
      status: 404,
      instance: '/api/nothing-here',
    });
  });
});
