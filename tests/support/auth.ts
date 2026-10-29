import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { sign } from 'hono/jwt';

import type { AuthConfig } from '../../src/config';

function generatePem(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

// The pair users-api would sign with. Minted per run: the private half never
// exists outside the suite.
const users = generatePem();
/** Another pair, to forge a token that is well formed but not users-api's. */
export const strangerKey = generatePem().privateKey;

export const TEST_AUTH: AuthConfig = { jwtPublicKey: users.publicKey, jwtIssuer: 'users-api' };

/** An access token of the same shape users-api issues, valid for 15 minutes. */
export async function issueToken(
  claims: Record<string, unknown> = {},
  { key = users.privateKey }: { key?: string } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      iss: 'users-api',
      sub: randomUUID(),
      role: 'user',
      jti: randomUUID(),
      iat: now,
      exp: now + 15 * 60,
      ...claims,
    },
    key,
    'EdDSA'
  );
}
