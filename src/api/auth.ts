import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';

import { ProblemError } from '../app/errors';
import type { AuthConfig } from '../config';

/** What a route behind `requireAccount` can read from the context. */
export interface AuthVariables {
  accountId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The same answer users-api and posts-api give, so the app handles a bad token
// the same way wherever it came from.
const invalidToken = () =>
  new ProblemError({
    status: 401,
    code: 'invalid-token',
    title: 'No se pudo autenticar la solicitud',
    detail: 'El token no es válido',
    headers: { 'www-authenticate': 'Bearer' },
  });

/**
 * Lets the request through only with an access token users-api signed.
 *
 * Signature, expiry and issuer are checked here, with the public key and
 * without calling anybody. Revocation is not: a token closed by a logout keeps
 * working until it expires, at most 15 minutes. posts-api closes that gap by
 * reading users-api's marks (ADR-014); this service does not, on purpose, while
 * all it accepts is a device token.
 */
export function requireAccount({ jwtPublicKey, jwtIssuer }: AuthConfig) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const [scheme, token] = c.req.header('authorization')?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw invalidToken();
    }

    let subject: unknown;
    try {
      ({ sub: subject } = await verify(token, jwtPublicKey, { alg: 'EdDSA', iss: jwtIssuer }));
    } catch {
      throw invalidToken();
    }
    // users-api always signs the account id as `sub`. Anything else was not
    // issued by it, signature or not.
    if (typeof subject !== 'string' || !UUID.test(subject)) {
      throw invalidToken();
    }

    c.set('accountId', subject.toLowerCase());
    await next();
  });
}
