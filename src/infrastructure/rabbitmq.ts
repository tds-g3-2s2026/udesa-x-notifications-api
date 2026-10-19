import type { EventEmitter } from 'node:events';

import { connect } from 'amqplib';

import type { DependencyCheck } from './health';
import { logEvent } from './telemetry';

// amqplib's own recovery: first retry after 1 s, doubling up to 30 s, forever.
// `waitForConnect: false` lets the service start with the broker down, so a
// RabbitMQ outage never becomes a crash loop.
const RECOVERY = { initialDelay: 1000, maxDelay: 30_000, waitForConnect: false };

export interface RabbitMQ extends DependencyCheck {
  close(): Promise<void>;
}

/**
 * Tracks whether a recovering amqplib connection is up right now. The
 * readiness probe reads that state; nothing is sent to the broker per probe.
 */
export function trackConnection(connection: EventEmitter & { close(): Promise<void> }): RabbitMQ {
  let connected = false;
  let lastError = 'connecting';

  connection.on('connect', () => {
    connected = true;
    logEvent('info', 'RabbitMQ connected');
  });
  connection.on('disconnect', (error: Error) => {
    connected = false;
    lastError = error.message;
    logEvent('warn', 'RabbitMQ disconnected, reconnecting', { error: error.message });
  });
  connection.on('connect-failed', (error: Error) => {
    lastError = error.message;
    logEvent('warn', 'RabbitMQ connection attempt failed', { error: error.message });
  });
  // An unhandled 'error' on an EventEmitter throws. What follows it is a
  // 'disconnect', which is where the state changes.
  connection.on('error', (error: Error) => {
    lastError = error.message;
  });

  return {
    name: 'rabbitmq',
    async check() {
      if (!connected) {
        throw new Error(lastError);
      }
    },
    close: () => connection.close(),
  };
}

export async function connectRabbitMQ(url: string): Promise<RabbitMQ> {
  return trackConnection(await connect(url, { recovery: RECOVERY }));
}
