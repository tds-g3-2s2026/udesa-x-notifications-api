import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DependencyCheck, HealthReport } from '../../src/infrastructure/health';
import { createMongoClient, mongodbCheck } from '../../src/infrastructure/mongodb';
import { connectRabbitMQ, type RabbitMQ } from '../../src/infrastructure/rabbitmq';
import { buildApp } from '../support/app';

// Against real MongoDB and RabbitMQ: docker/docker-compose.dev.yml locally,
// ci-node.yml's `mongodb-y-rabbitmq` in the CI. Fails loudly when they are not
// configured, so the CI never passes by skipping these.
const { MONGODB_URL, RABBITMQ_URL } = process.env;
if (!MONGODB_URL || !RABBITMQ_URL) {
  throw new Error('tests/integration needs MONGODB_URL and RABBITMQ_URL');
}

// Nothing listens there, on any machine that runs this suite.
const UNREACHABLE_MONGODB = 'mongodb://127.0.0.1:1/notifications';
const UNREACHABLE_RABBITMQ = 'amqp://127.0.0.1:1';

const opened: { close(): Promise<void> }[] = [];

function mongo(url: string): MongoClient {
  const client = createMongoClient(url);
  opened.push(client);
  return client;
}

async function rabbitmq(url: string): Promise<RabbitMQ> {
  const connection = await connectRabbitMQ(url);
  opened.push(connection);
  return connection;
}

beforeAll(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(async () => {
  await Promise.allSettled(opened.map((connection) => connection.close()));
});

async function healthcheck(checks: DependencyCheck[]) {
  const res = await buildApp({ healthChecks: checks }).request('/healthcheck');
  return { status: res.status, body: (await res.json()) as HealthReport };
}

describe('GET /healthcheck against real dependencies', () => {
  it('answers 200 once MongoDB answers and RabbitMQ is connected', async () => {
    const broker = await rabbitmq(RABBITMQ_URL);
    await vi.waitFor(() => broker.check(), { timeout: 10_000, interval: 100 });

    const { status, body } = await healthcheck([mongodbCheck(mongo(MONGODB_URL)), broker]);

    expect(status).toBe(200);
    expect(body.dependencies).toEqual({ mongodb: 'ok', rabbitmq: 'ok' });
  });

  it('answers 503 with the reason when MongoDB cannot be reached', async () => {
    const broker = await rabbitmq(RABBITMQ_URL);
    await vi.waitFor(() => broker.check(), { timeout: 10_000, interval: 100 });

    const { status, body } = await healthcheck([mongodbCheck(mongo(UNREACHABLE_MONGODB)), broker]);

    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.dependencies.rabbitmq).toBe('ok');
    expect(body.dependencies.mongodb).toMatch(/ECONNREFUSED|timed out/);
  });

  it('answers 503 with the reason while RabbitMQ refuses the connection', async () => {
    const broker = await rabbitmq(UNREACHABLE_RABBITMQ);
    await vi.waitFor(
      async () => {
        await expect(broker.check()).rejects.toThrow(/ECONNREFUSED/);
      },
      { timeout: 10_000, interval: 100 }
    );

    const { status, body } = await healthcheck([mongodbCheck(mongo(MONGODB_URL)), broker]);

    expect(status).toBe(503);
    expect(body.dependencies.mongodb).toBe('ok');
    expect(body.dependencies.rabbitmq).toMatch(/ECONNREFUSED/);
  });
});
