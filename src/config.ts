export interface Config {
  port: number;
  mongodbUrl: string;
  rabbitmqUrl: string;
}

const REQUIRED = ['MONGODB_URL', 'RABBITMQ_URL'] as const;

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
  };
}
