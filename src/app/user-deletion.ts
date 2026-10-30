import { logEvent } from '../infrastructure/telemetry';
import type { DeviceTokenStore } from './device-tokens';
import type { HandlerResult } from './events';
import type { NotificationStore } from './notifications';

export const USER_DELETED = 'user.deleted.v1';

/** The memory of the events already handled to the end, by their id. */
export interface ProcessedEventStore {
  has(id: string): Promise<boolean>;
  /** Remembers the event as handled. Recording the same id again changes nothing. */
  record(event: { id: string; type: string; userId: string }, at: Date): Promise<void>;
}

interface UserDeleted {
  id: string;
  userId: string;
  deletedAt: Date;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

// Anything that is not an object reads as one with no fields, so the checks
// below name the first field that is missing.
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

// Keep in step with contracts/events/user.deleted.v1.json.
function parseUserDeleted(body: string): UserDeleted | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { error: 'body is not valid JSON' };
  }
  const envelope = asRecord(json);
  const data = asRecord(envelope.data);
  if (!isText(envelope.id)) {
    return { error: 'missing id' };
  }
  if (envelope.type !== USER_DELETED) {
    return { error: 'not a user.deleted.v1 event' };
  }
  const deletedAt = new Date(isText(envelope.time) ? envelope.time : Number.NaN);
  if (Number.isNaN(deletedAt.getTime())) {
    return { error: 'missing time' };
  }
  if (!isText(data.user_id)) {
    return { error: 'missing data.user_id' };
  }
  // Account ids are stored the way requireAccount hands them: lowercase.
  return { id: envelope.id, userId: data.user_id.toLowerCase(), deletedAt };
}

/**
 * When an account is deleted, its device tokens and its notifications are
 * marked deleted with the instant of the deletion. Nothing is removed.
 *
 * MongoDB runs here without transactions across documents, so the steps are
 * ordered to survive a crash between them: both updates first, the record of
 * the event last. A failure throws, the consumer requeues the message and the
 * retry does the whole thing again. That is safe because both updates skip
 * what is already deleted, and the date of the first pass stays.
 *
 * Two deliveries of the same event handled at once can both get past the
 * check and both run the updates. Unlike an email, that sends nothing twice:
 * the date is the event's, so they write the same, and one record is kept.
 */
export function createUserDeletedHandler(deps: {
  deviceTokens: DeviceTokenStore;
  notifications: NotificationStore;
  processedEvents: ProcessedEventStore;
  now?: () => Date;
}) {
  const { deviceTokens, notifications, processedEvents, now = () => new Date() } = deps;

  return async function handle(body: string): Promise<HandlerResult> {
    const event = parseUserDeleted(body);
    if ('error' in event) {
      logEvent('warn', 'Discarding event that cannot be handled', {
        reason: event.error,
        type: USER_DELETED,
      });
      return 'dead-letter';
    }

    const { id, userId, deletedAt } = event;
    if (await processedEvents.has(id)) {
      logEvent('info', 'Duplicate event dropped', { id, type: USER_DELETED });
      return 'ack';
    }

    await deviceTokens.softDeleteOwnedBy(userId, deletedAt);
    await notifications.softDeleteOwnedBy(userId, deletedAt);
    await processedEvents.record({ id, type: USER_DELETED, userId }, now());
    logEvent('info', 'Device tokens and notifications of a deleted account soft-deleted', {
      id,
      userId,
    });
    return 'ack';
  };
}
