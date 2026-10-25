import { Hono } from 'hono';

import type { DeviceTokenStore } from '../app/device-tokens';
import { ProblemError, type FieldError } from '../app/errors';
import type { AuthConfig } from '../config';
import { requireAccount, type AuthVariables } from './auth';

// An FCM registration token is around 160 characters. The bound only keeps a
// client from storing arbitrary amounts of text under its account.
export const MAX_TOKEN_LENGTH = 4096;

const invalid = (error: FieldError) =>
  new ProblemError({
    status: 422,
    code: 'validation-failed',
    title: 'La solicitud tiene campos inválidos',
    detail: 'Revisá los campos indicados y volvé a intentar.',
    errors: [error],
  });

async function readToken(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalid({ field: 'body', message: 'Tiene que ser un objeto JSON' });
  }
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw invalid({ field: 'token', message: 'Es obligatorio' });
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    throw invalid({ field: 'token', message: `No puede superar ${MAX_TOKEN_LENGTH} caracteres` });
  }
  return token;
}

/**
 * Mounted under /api/notifications, the prefix the gateway sends here. The
 * account is the one in the token, never one in the body: nobody can register a
 * device under somebody else.
 */
export function deviceTokenRoutes({ auth, store }: { auth: AuthConfig; store: DeviceTokenStore }) {
  const routes = new Hono<{ Variables: AuthVariables }>();

  // E4-H1 CA.3: the app calls this after every login, also when the token did
  // not change, so the latest owner and time always win.
  routes.post('/device-tokens', requireAccount(auth), async (c) => {
    const token = await readToken(c.req.raw);
    await store.register(token, c.get('accountId'), new Date());
    return c.body(null, 204);
  });

  return routes;
}
