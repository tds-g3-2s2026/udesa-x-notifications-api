import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceTokenStore } from '../../src/app/device-tokens';
import type { NotificationStore } from '../../src/app/notifications';
import { createUserDeletedHandler, type ProcessedEventStore } from '../../src/app/user-deletion';
import { exampleEvent } from '../support/contracts';

const NOW = new Date('2026-10-30T12:00:00Z');

function setup({ processed = false } = {}) {
  const calls: string[] = [];
  const deviceTokens = {
    register: vi.fn(),
    activeTokensOf: vi.fn(),
    softDeleteOwnedBy: vi.fn<DeviceTokenStore['softDeleteOwnedBy']>(async () => {
      calls.push('tokens');
    }),
  } satisfies DeviceTokenStore;
  const notifications = {
    add: vi.fn(),
    page: vi.fn(),
    markAllRead: vi.fn(),
    softDelete: vi.fn(),
    softDeleteOwnedBy: vi.fn<NotificationStore['softDeleteOwnedBy']>(async () => {
      calls.push('notifications');
    }),
  } satisfies NotificationStore;
  const processedEvents = {
    has: vi.fn<ProcessedEventStore['has']>(async () => processed),
    record: vi.fn<ProcessedEventStore['record']>(async () => {
      calls.push('record');
    }),
  } satisfies ProcessedEventStore;
  const handle = createUserDeletedHandler({
    deviceTokens,
    notifications,
    processedEvents,
    now: () => NOW,
  });
  return { handle, deviceTokens, notifications, processedEvents, calls };
}

const event = () => exampleEvent('user.deleted.v1');

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('user.deleted handler', () => {
  it('soft-deletes the tokens and the notifications at the time of the event, then records it', async () => {
    const { handle, deviceTokens, notifications, processedEvents, calls } = setup();
    const deleted = event();

    await expect(handle(JSON.stringify(deleted))).resolves.toBe('ack');

    const at = new Date(deleted.time);
    expect(deviceTokens.softDeleteOwnedBy).toHaveBeenCalledWith(deleted.data.user_id, at);
    expect(notifications.softDeleteOwnedBy).toHaveBeenCalledWith(deleted.data.user_id, at);
    expect(processedEvents.record).toHaveBeenCalledWith(
      { id: deleted.id, type: 'user.deleted.v1', userId: deleted.data.user_id },
      NOW
    );
    // The record goes last: it only says done once everything is.
    expect(calls).toEqual(['tokens', 'notifications', 'record']);
  });

  it('looks the account up in lowercase, the way requireAccount stores it', async () => {
    const { handle, notifications } = setup();
    const deleted = event();
    deleted.data.user_id = deleted.data.user_id.toUpperCase();

    await handle(JSON.stringify(deleted));

    expect(notifications.softDeleteOwnedBy).toHaveBeenCalledWith(
      deleted.data.user_id.toLowerCase(),
      expect.any(Date)
    );
  });

  it('drops an event already handled, touching nothing', async () => {
    const { handle, deviceTokens, notifications, processedEvents } = setup({ processed: true });

    await expect(handle(JSON.stringify(event()))).resolves.toBe('ack');

    expect(deviceTokens.softDeleteOwnedBy).not.toHaveBeenCalled();
    expect(notifications.softDeleteOwnedBy).not.toHaveBeenCalled();
    expect(processedEvents.record).not.toHaveBeenCalled();
  });

  it('throws, so the message is requeued, and records nothing when a store fails', async () => {
    const { handle, notifications, processedEvents } = setup();
    notifications.softDeleteOwnedBy.mockRejectedValueOnce(new Error('MongoDB is down'));

    await expect(handle(JSON.stringify(event()))).rejects.toThrow('MongoDB is down');

    expect(processedEvents.record).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', () => '{nope', 'body is not valid JSON'],
    ['no id', () => JSON.stringify({ ...event(), id: '' }), 'missing id'],
    [
      'another type',
      () => JSON.stringify({ ...event(), type: 'user.registered.v1' }),
      'not a user.deleted.v1 event',
    ],
    ['no time', () => JSON.stringify({ ...event(), time: undefined }), 'missing time'],
    ['a time that is no date', () => JSON.stringify({ ...event(), time: 'ayer' }), 'missing time'],
    ['no data', () => JSON.stringify({ ...event(), data: null }), 'missing data.user_id'],
    ['no user_id', () => JSON.stringify({ ...event(), data: {} }), 'missing data.user_id'],
  ])('sends to the DLQ an event with %s, touching nothing', async (_, body, reason) => {
    const { handle, deviceTokens, processedEvents } = setup();

    await expect(handle(body())).resolves.toBe('dead-letter');

    expect(console.warn).toHaveBeenCalledWith('Discarding event that cannot be handled', {
      reason,
      type: 'user.deleted.v1',
    });
    expect(processedEvents.has).not.toHaveBeenCalled();
    expect(deviceTokens.softDeleteOwnedBy).not.toHaveBeenCalled();
  });
});
