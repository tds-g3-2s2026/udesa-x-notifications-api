import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { trackConnection } from '../../src/infrastructure/rabbitmq';

// Stands in for amqplib's recovering connection, which reports its state
// through these events. The real one is exercised in tests/integration.
function fakeConnection() {
  return Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('trackConnection', () => {
  it('is down until the first connection succeeds', async () => {
    const rabbitmq = trackConnection(fakeConnection());

    await expect(rabbitmq.check()).rejects.toThrow('connecting');
  });

  it('reports why the last attempt failed while it keeps retrying', async () => {
    const connection = fakeConnection();
    const rabbitmq = trackConnection(connection);

    connection.emit('connect-failed', new Error('connect ECONNREFUSED 127.0.0.1:5672'));

    await expect(rabbitmq.check()).rejects.toThrow('connect ECONNREFUSED 127.0.0.1:5672');
  });

  it('goes up on connect, down on disconnect, and up again on reconnect', async () => {
    const connection = fakeConnection();
    const rabbitmq = trackConnection(connection);

    connection.emit('connect');
    await expect(rabbitmq.check()).resolves.toBeUndefined();

    connection.emit('error', new Error('CONNECTION_FORCED - broker forced connection closure'));
    connection.emit('disconnect', new Error('Connection closed'));
    await expect(rabbitmq.check()).rejects.toThrow('Connection closed');

    connection.emit('connect');
    await expect(rabbitmq.check()).resolves.toBeUndefined();
  });

  it('closes the underlying connection', async () => {
    const connection = fakeConnection();

    await trackConnection(connection).close();

    expect(connection.close).toHaveBeenCalledOnce();
  });
});
