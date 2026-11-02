import { logEvent } from '../infrastructure/telemetry';
import type { DeviceTokenStore } from './device-tokens';
import type { HandlerResult } from './events';
import type { NotificationStore } from './notifications';
import type { PushSender } from './push';

export const FOLLOW_CREATED = 'follow.created.v1';

interface FollowCreated {
  id: string;
  followerId: string;
  followerHandle: string | null;
  followeeId: string;
  createdAt: Date;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

// Anything that is not an object reads as one with no fields, so the checks
// below name the first field that is missing.
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

// Keep in step with contracts/events/follow.created.v1.json.
function parseFollowCreated(body: string): FollowCreated | { error: string } {
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
  if (envelope.type !== FOLLOW_CREATED) {
    return { error: 'not a follow.created.v1 event' };
  }
  const createdAt = new Date(isText(envelope.time) ? envelope.time : Number.NaN);
  if (Number.isNaN(createdAt.getTime())) {
    return { error: 'missing time' };
  }
  if (!isText(data.follower_id)) {
    return { error: 'missing data.follower_id' };
  }
  if (!isText(data.followee_id)) {
    return { error: 'missing data.followee_id' };
  }
  return {
    id: envelope.id,
    // Account ids are stored the way requireAccount hands them: lowercase.
    followerId: data.follower_id.toLowerCase(),
    followeeId: data.followee_id.toLowerCase(),
    // Only the text uses it: a handle posts-api did not know is no reason to
    // drop the event.
    followerHandle: isText(data.follower_handle) ? data.follower_handle : null,
    createdAt,
  };
}

/**
 * A new follower (E4-H1): an entry in the followed account's notification
 * center, and a push to every device of that account.
 *
 * The entry is also the memory of what was handled: its id is the event's, so
 * `add` answers false for an event seen before, and then nothing is sent.
 * MongoDB runs without transactions across documents, so the order matters:
 *
 * 1. The tokens are read first. If that fails the message is requeued with
 *    nothing done yet.
 * 2. The entry is added. A duplicate stops here.
 * 3. The push goes out.
 *
 * A crash between 2 and 3 loses that push, while the entry stays in the center.
 * That is accepted over the alternative, recording after the send, which
 * repeats the push whenever the same event is handled twice.
 *
 * A push the provider refuses is not retried: it is logged and the message
 * acked, as with emails. The tokens FCM says no longer exist are marked
 * deleted afterwards (E4-H1 CA.4); if that fails it is only logged, since the
 * next push to the account reports them again.
 */
export function createFollowCreatedHandler(deps: {
  notifications: NotificationStore;
  deviceTokens: DeviceTokenStore;
  push: PushSender;
  now?: () => Date;
}) {
  const { notifications, deviceTokens, push, now = () => new Date() } = deps;

  return async function handle(body: string): Promise<HandlerResult> {
    const event = parseFollowCreated(body);
    if ('error' in event) {
      logEvent('warn', 'Discarding event that cannot be handled', {
        reason: event.error,
        type: FOLLOW_CREATED,
      });
      return 'dead-letter';
    }

    const { id, followerId, followerHandle, followeeId, createdAt } = event;
    const tokens = await deviceTokens.activeTokensOf(followeeId);
    const added = await notifications.add({
      id,
      recipientId: followeeId,
      type: 'follow',
      actor: { id: followerId, handle: followerHandle },
      postId: null,
      replyId: null,
      createdAt,
    });
    if (!added) {
      logEvent('info', 'Duplicate event dropped', { id, type: FOLLOW_CREATED });
      return 'ack';
    }
    if (tokens.length === 0) {
      logEvent('info', 'No device to push to', { id, type: FOLLOW_CREATED });
      return 'ack';
    }

    let invalidTokens: string[];
    try {
      ({ invalidTokens } = await push.send(tokens, {
        title: 'Nuevo seguidor',
        body: followerHandle
          ? `@${followerHandle} te empezó a seguir`
          : 'Alguien te empezó a seguir',
        // What the app opens on a tap: the follower's profile (E4-H1 CA.2).
        data: { type: 'follow', actorId: followerId },
      }));
    } catch (error) {
      logEvent('warn', 'Push not sent', {
        id,
        type: FOLLOW_CREATED,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return 'ack';
    }
    logEvent('info', 'Push sent', { id, type: FOLLOW_CREATED, devices: String(tokens.length) });

    if (invalidTokens.length > 0) {
      try {
        await deviceTokens.softDelete(invalidTokens, now());
        logEvent('info', 'Invalid device tokens soft-deleted', {
          id,
          count: String(invalidTokens.length),
        });
      } catch (error) {
        logEvent('warn', 'Could not soft-delete invalid device tokens', {
          id,
          error: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }
    return 'ack';
  };
}
