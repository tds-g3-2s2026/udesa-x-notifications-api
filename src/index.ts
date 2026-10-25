import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

import { createApp } from './api/app';
import { createEmailEventHandler } from './app/email-events';
import { loadConfig } from './config';
import { createDeviceTokenStore, deviceTokenCollection } from './infrastructure/device-token-store';
import { createEmailSender } from './infrastructure/email-senders';
import { createEmailStore, emailCollection } from './infrastructure/email-store';
import { createEventConsumer } from './infrastructure/event-consumer';
import { createMongoClient, mongodbCheck } from './infrastructure/mongodb';
import { connectRabbitMQ } from './infrastructure/rabbitmq';
import { startTelemetry } from './infrastructure/telemetry';

// The only module that knows the concrete implementations (ADR-007): it opens
// the connections and hands them to the app.
const config = loadConfig();

// Telemetry leaves the pod only when an endpoint is set. The exporters read it,
// and the rest of the OTEL_EXPORTER_OTLP_* variables, on their own.
const telemetry = startTelemetry(
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { spans: new OTLPTraceExporter(), logs: new OTLPLogExporter() }
    : undefined
);

const mongo = createMongoClient(config.mongodbUrl);

// Starts consuming as soon as RabbitMQ is reachable, and again after every
// reconnection.
const consumer = createEventConsumer(
  createEmailEventHandler({
    store: createEmailStore(emailCollection(mongo)),
    sender: createEmailSender(config.email),
  })
);
const rabbitmq = await connectRabbitMQ(config.rabbitmqUrl, consumer.setup);

const app = createApp({
  healthChecks: [mongodbCheck(mongo), rabbitmq],
  auth: config.auth,
  deviceTokens: createDeviceTokenStore(deviceTokenCollection(mongo)),
});

// Kubernetes sends SIGTERM before stopping the pod: the consumer finishes the
// messages it holds, connections close cleanly and the last telemetry batches
// go out before the process exits.
process.on('SIGTERM', async () => {
  await consumer.drain();
  await Promise.allSettled([
    rabbitmq.close(),
    mongo.close(),
    telemetry?.tracerProvider.shutdown(),
    telemetry?.loggerProvider.shutdown(),
  ]);
  process.exit(0);
});

// Bun starts an HTTP server from this shape when the file is run directly
// (`bun run src/index.ts`).
export default {
  port: config.port,
  fetch: app.fetch,
};
