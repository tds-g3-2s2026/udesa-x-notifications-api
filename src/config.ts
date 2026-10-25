export type EmailConfig =
  { provider: 'console'; from: string } | { provider: 'resend'; apiKey: string; from: string };

export interface AuthConfig {
  /** Ed25519 public key in PEM, the other half of the key users-api signs with. */
  jwtPublicKey: string;
  jwtIssuer: string;
}

export interface Config {
  port: number;
  mongodbUrl: string;
  rabbitmqUrl: string;
  email: EmailConfig;
  auth: AuthConfig;
}

// JWT_PUBLIC_KEY has no default either: without it the service could not tell
// a real token from a forged one, so it refuses to start rather than accept
// everything.
const REQUIRED = ['MONGODB_URL', 'RABBITMQ_URL', 'JWT_PUBLIC_KEY'] as const;

// Domain verified in Resend (ADR-010).
const DEFAULT_EMAIL_FROM = 'UdeSA-X <no-reply@udesax.app>';

function loadEmailConfig(env: Record<string, string | undefined>): EmailConfig {
  const provider = env.EMAIL_PROVIDER || 'console';
  const from = env.EMAIL_FROM || DEFAULT_EMAIL_FROM;
  if (provider === 'console') {
    return { provider, from };
  }
  if (provider === 'resend') {
    // Without a key every email would fail at the first event.
    if (!env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
    }
    return { provider, apiKey: env.RESEND_API_KEY, from };
  }
  throw new Error(`EMAIL_PROVIDER must be 'console' or 'resend', got '${provider}'`);
}

// No defaults for the connection URLs: a service that silently points at
// nothing would look healthy until the first event. Read once at startup, so a
// missing variable stops the process instead of the first request.
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    port: Number(env.PORT ?? 8000),
    mongodbUrl: env.MONGODB_URL!,
    rabbitmqUrl: env.RABBITMQ_URL!,
    email: loadEmailConfig(env),
    auth: { jwtPublicKey: env.JWT_PUBLIC_KEY!, jwtIssuer: env.JWT_ISSUER || 'users-api' },
  };
}
