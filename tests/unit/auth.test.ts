import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { requireAccount, type AuthVariables } from '../../src/api/auth';
import { onError } from '../../src/api/errors';
import { issueToken, strangerKey, TEST_AUTH } from '../support/auth';

const PATH = '/private';

/** A route behind the middleware that answers with the account it was handed. */
function protectedApp() {
  const reached: string[] = [];
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(onError);
  app.get(PATH, requireAccount(TEST_AUTH), (c) => {
    reached.push(c.get('accountId'));
    return c.json({ accountId: c.get('accountId') });
  });
  return { app, reached };
}

function get(app: Hono<{ Variables: AuthVariables }>, authorization?: string) {
  return app.request(PATH, { headers: authorization ? { authorization } : {} });
}

describe('requireAccount', () => {
  it('lets a users-api token through with its subject as the account', async () => {
    const { app } = protectedApp();
    const account = randomUUID();

    const res = await get(app, `Bearer ${await issueToken({ sub: account })}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: account });
  });

  it('hands the account id in lowercase, however the token spells it', async () => {
    const { app } = protectedApp();
    const account = randomUUID();

    const res = await get(app, `bearer ${await issueToken({ sub: account.toUpperCase() })}`);

    expect(await res.json()).toEqual({ accountId: account });
  });

  it.each([
    ['no Authorization header', async () => undefined],
    ['another scheme', async () => `Basic ${await issueToken()}`],
    ['a Bearer with nothing after it', async () => 'Bearer '],
    ['something that is not a JWT', async () => 'Bearer not-a-jwt'],
    ['an expired token', async () => `Bearer ${await issueToken({ exp: 1 })}`],
    ['another issuer', async () => `Bearer ${await issueToken({ iss: 'posts-api' })}`],
    [
      'a key that is not users-api',
      async () => `Bearer ${await issueToken({}, { key: strangerKey })}`,
    ],
    [
      'a subject that is not an account id',
      async () => `Bearer ${await issueToken({ sub: 'admin' })}`,
    ],
  ])(
    'answers 401 invalid-token for %s and never reaches the route',
    async (_case, authorization) => {
      const { app, reached } = protectedApp();

      const res = await get(app, await authorization());

      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
      expect(await res.json()).toMatchObject({
        type: 'https://udesa-x.dev/errors/invalid-token',
        status: 401,
        detail: 'El token no es válido',
        instance: PATH,
      });
      expect(reached).toEqual([]);
    }
  );
});
