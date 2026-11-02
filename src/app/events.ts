import { EMAIL_EVENT_TYPES } from './email-events';
import { FOLLOW_CREATED } from './follows';
import { USER_DELETED } from './user-deletion';

/**
 * `ack`: handled, or already handled before. `dead-letter`: the message can
 * never be handled, so it goes to the DLQ instead of being retried.
 */
export type HandlerResult = 'ack' | 'dead-letter';

export type EventHandler = (body: string) => Promise<HandlerResult>;

/** The routing keys the service binds its queue with: one per type it handles. */
export const EVENT_TYPES = [...EMAIL_EVENT_TYPES, USER_DELETED, FOLLOW_CREATED];

function typeOf(body: string): unknown {
  try {
    return (JSON.parse(body) as { type?: unknown } | null)?.type;
  } catch {
    return undefined;
  }
}

/**
 * One queue carries every event, so each message goes to the handler of its
 * type. Only the type is read here. Whatever has no handler of its own goes to
 * the email handler as before, which also sends what it cannot read to the DLQ.
 */
export function routeEvents(handlers: {
  email: EventHandler;
  userDeleted: EventHandler;
  followCreated: EventHandler;
}): EventHandler {
  const byType: Record<string, EventHandler> = {
    [USER_DELETED]: handlers.userDeleted,
    [FOLLOW_CREATED]: handlers.followCreated,
  };
  return (body) => {
    const type = typeOf(body);
    // Own keys only: a `type` like "constructor" must not reach Object's.
    return typeof type === 'string' && Object.hasOwn(byType, type)
      ? byType[type](body)
      : handlers.email(body);
  };
}
