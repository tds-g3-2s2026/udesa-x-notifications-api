import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { MAX_TOKEN_LENGTH, type DeviceTokenStore } from '../../src/app/device-tokens';
import { buildApp } from '../support/app';
import { issueToken } from '../support/auth';

// The HTTP side only, with the store as a double. What the store does with
// MongoDB is in tests/integration/device-token-store.test.ts.
function fakeStore() {
  return {
    register: vi.fn<DeviceTokenStore['register']>(async () => {}),
    activeTokensOf: vi.fn(),
    softDeleteOwnedBy: vi.fn(),
  } satisfies DeviceTokenStore;
}

/** POST /api/notifications/device-tokens with `body` sent as is. */
async function post(
  store: DeviceTokenStore,
  body: string | undefined,
  { account = randomUUID() } = {}
) {
  return buildApp({ deviceTokens: store }).request('/api/notifications/device-tokens', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await issueToken({ sub: account })}`,
      'content-type': 'application/json',
    },
    body,
  });
}

describe('POST /api/notifications/device-tokens', () => {
  it('E4-H1.CA3 registers the token under the account of the access token, never one in the body', async () => {
    const store = fakeStore();
    const account = randomUUID();
    const body = JSON.stringify({ token: 'fcm-token', accountId: randomUUID() });

    const res = await post(store, body, { account });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(store.register).toHaveBeenCalledExactlyOnceWith('fcm-token', account, expect.any(Date));
  });

  it(`takes a token of exactly ${MAX_TOKEN_LENGTH} characters`, async () => {
    const store = fakeStore();

    const res = await post(store, JSON.stringify({ token: 'x'.repeat(MAX_TOKEN_LENGTH) }));

    expect(res.status).toBe(204);
  });

  it.each([
    ['no body', undefined],
    ['a body that is not JSON', '{token:'],
    ['JSON null', 'null'],
    ['no token', '{}'],
    ['a token that is not text', JSON.stringify({ token: 42 })],
    ['an empty token', JSON.stringify({ token: '' })],
    ['a token that is too long', JSON.stringify({ token: 'x'.repeat(MAX_TOKEN_LENGTH + 1) })],
  ])('answers 422 validation-failed naming the field for %s, storing nothing', async (_, body) => {
    const store = fakeStore();

    const res = await post(store, body);

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await res.json()).toMatchObject({
      type: 'https://udesa-x.dev/errors/validation-failed',
      status: 422,
      errors: [{ field: 'token', message: expect.any(String) }],
    });
    expect(store.register).not.toHaveBeenCalled();
  });

  it('answers 401 without an access token, storing nothing', async () => {
    const store = fakeStore();

    const res = await buildApp({ deviceTokens: store }).request(
      '/api/notifications/device-tokens',
      { method: 'POST', body: JSON.stringify({ token: 'fcm-token' }) }
    );

    expect(res.status).toBe(401);
    expect(store.register).not.toHaveBeenCalled();
  });
});
