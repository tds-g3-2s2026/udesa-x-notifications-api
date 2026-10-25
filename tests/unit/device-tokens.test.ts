import { randomUUID } from 'node:crypto';

import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { MAX_TOKEN_LENGTH } from '../../src/api/device-tokens';
import { buildApp, recordingStore } from '../support/app';
import { issueToken, strangerKey } from '../support/auth';

const PATH = '/api/notifications/device-tokens';

function post(app: Hono, body: string, authorization?: string) {
  return app.request(PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body,
  });
}

describe('POST /api/notifications/device-tokens', () => {
  it('E4-H1.CA3 registers the device token under the account of the access token', async () => {
    const store = recordingStore();
    const app = buildApp({ deviceTokens: store });
    const account = randomUUID();

    const res = await post(
      app,
      JSON.stringify({ token: 'fcm-token-1' }),
      `Bearer ${await issueToken({ sub: account })}`
    );

    expect(res.status).toBe(204);
    expect(store.registered).toEqual([
      { token: 'fcm-token-1', accountId: account, at: expect.any(Date) },
    ]);
  });

  it('never takes the account from the body', async () => {
    const store = recordingStore();
    const app = buildApp({ deviceTokens: store });
    const account = randomUUID();

    await post(
      app,
      JSON.stringify({ token: 'fcm-token-1', accountId: randomUUID(), account_id: randomUUID() }),
      `Bearer ${await issueToken({ sub: account })}`
    );

    expect(store.registered.map((one) => one.accountId)).toEqual([account]);
  });

  // Every way a token can fail is in auth.test.ts; this only proves the route
  // sits behind that check.
  it('answers 401 to a token users-api did not sign and stores nothing', async () => {
    const store = recordingStore();
    const app = buildApp({ deviceTokens: store });
    const forged = await issueToken({}, { key: strangerKey });

    const res = await post(app, JSON.stringify({ token: 'fcm-token-1' }), `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'https://udesa-x.dev/errors/invalid-token' });
    expect(store.registered).toEqual([]);
  });

  it('checks the token before the body: a stranger learns nothing about the shape', async () => {
    const res = await post(buildApp(), 'not json');

    expect(res.status).toBe(401);
  });

  it.each([
    [
      'a body that is not JSON',
      'not json',
      { field: 'body', message: 'Tiene que ser un objeto JSON' },
    ],
    ['a JSON null', 'null', { field: 'token', message: 'Es obligatorio' }],
    ['no token', '{}', { field: 'token', message: 'Es obligatorio' }],
    ['an empty token', '{"token":""}', { field: 'token', message: 'Es obligatorio' }],
    ['a token that is not a string', '{"token":42}', { field: 'token', message: 'Es obligatorio' }],
    [
      'a token past the limit',
      JSON.stringify({ token: 'x'.repeat(MAX_TOKEN_LENGTH + 1) }),
      { field: 'token', message: `No puede superar ${MAX_TOKEN_LENGTH} caracteres` },
    ],
  ])('answers 422 with the field for %s', async (_case, body, error) => {
    const store = recordingStore();
    const app = buildApp({ deviceTokens: store });

    const res = await post(app, body, `Bearer ${await issueToken()}`);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      type: 'https://udesa-x.dev/errors/validation-failed',
      status: 422,
      errors: [error],
    });
    expect(store.registered).toEqual([]);
  });

  it('accepts a token right at the limit', async () => {
    const res = await post(
      buildApp(),
      JSON.stringify({ token: 'x'.repeat(MAX_TOKEN_LENGTH) }),
      `Bearer ${await issueToken()}`
    );

    expect(res.status).toBe(204);
  });
});
