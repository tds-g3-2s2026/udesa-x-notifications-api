import { logEvent } from '../infrastructure/telemetry';
import { actorName, createNotificationDelivery, type DeliveryDeps } from './delivery';
import type { HandlerResult } from './events';

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
 * A new follower: an entry in the followed account's notification center, and
 * a push to every device of that account, through the shared delivery.
 */
export function createFollowCreatedHandler(deps: DeliveryDeps) {
  const deliver = createNotificationDelivery(deps);

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
    return deliver(
      FOLLOW_CREATED,
      {
        id,
        recipientId: followeeId,
        type: 'follow',
        actor: { id: followerId, handle: followerHandle },
        postId: null,
        replyId: null,
        createdAt,
      },
      {
        title: 'Nuevo seguidor',
        body: `${actorName(followerHandle)} te empezó a seguir`,
        // What the app opens on a tap: the follower's profile.
        data: { type: 'follow', actorId: followerId },
      }
    );
  };
}
