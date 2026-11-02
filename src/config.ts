export type EmailConfig =
  { provider: 'console'; from: string } | { provider: 'resend'; apiKey: string; from: string };

/** The Firebase service account the FCM adapter signs in with. */
export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export type PushConfig =
  { provider: 'console' } | { provider: 'fcm'; serviceAccount: ServiceAccount };

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
  push: PushConfig;
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

// The key file exactly as the Firebase console downloads it, whole. Its fields
// are checked here so a wrong secret stops the start instead of the first push.
// No message carries the contents: the file holds a private key.
function parseServiceAccount(raw: string): ServiceAccount {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  }
  const { project_id, client_email, private_key } = (json ?? {}) as Record<string, unknown>;
  if (
    typeof project_id !== 'string' ||
    typeof client_email !== 'string' ||
    typeof private_key !== 'string'
  ) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT must have project_id, client_email and private_key');
  }
  return { projectId: project_id, clientEmail: client_email, privateKey: private_key };
}

function loadPushConfig(env: Record<string, string | undefined>): PushConfig {
  const provider = env.PUSH_PROVIDER || 'console';
  if (provider === 'console') {
    return { provider };
  }
  if (provider === 'fcm') {
    // Without a service account every push would fail at the first event.
    if (!env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is required when PUSH_PROVIDER=fcm');
    }
    return { provider, serviceAccount: parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT) };
  }
  throw new Error(`PUSH_PROVIDER must be 'console' or 'fcm', got '${provider}'`);
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
    push: loadPushConfig(env),
    auth: { jwtPublicKey: env.JWT_PUBLIC_KEY!, jwtIssuer: env.JWT_ISSUER || 'users-api' },
  };
}
