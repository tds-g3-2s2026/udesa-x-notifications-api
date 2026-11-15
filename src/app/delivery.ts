import { logEvent } from '../infrastructure/telemetry';
import type { DeviceTokenStore } from './device-tokens';
import type { HandlerResult } from './events';
import type { Notification, NotificationStore } from './notifications';
import { wantsPush, type PreferenceStore } from './preferences';
import type { PushMessage, PushSender } from './push';

export interface DeliveryDeps {
  notifications: NotificationStore;
  deviceTokens: DeviceTokenStore;
  preferences: PreferenceStore;
  push: PushSender;
  now?: () => Date;
}

/**
 * How a push names who did it. users-api handles carry their leading @, but the
 * contract examples leave it out, so it is added only when missing. A handle
 * posts-api did not know reads as "Alguien".
 */
export function actorName(handle: string | null): string {
  if (!handle) return 'Alguien';
  return handle.startsWith('@') ? handle : `@${handle}`;
}

/**
 * What every event that notifies an account does once its handler knows what
 * to say: an entry in the recipient's notification center, and a push to every
 * device of that account. The only place that sends a push, so every kind of
 * notification follows the same rules.
 *
 * The push is the only part the recipient can turn off (E4-H5 CA.2): the
 * entry goes to the center whatever the account chose, because the preference
 * is about alerts. The preference is read by the type of the entry, so a new
 * kind of notification is covered without touching the handler that produces it.
 *
 * The entry is also the memory of what was handled: its id is the event's, so
 * `add` answers false for an event seen before, and then nothing is sent.
 * MongoDB runs without transactions across documents, so the order matters:
 *
 * 1. The preference and the tokens are read first. If that fails the message
 *    is requeued with nothing done yet.
 * 2. The entry is added. A duplicate stops here, and so does an account that
 *    turned that type off.
 * 3. The push goes out.
 *
 * A crash between 2 and 3 loses that push, while the entry stays in the center.
 * That is accepted over the alternative, recording after the send, which
 * repeats the push whenever the same event is handled twice.
 *
 * A push the provider refuses is not retried: it is logged and the message
 * acked, as with emails. The tokens FCM says no longer exist are marked
 * deleted afterwards; if that fails it is only logged, since the next push to
 * the account reports them again.
 */
export function createNotificationDelivery(deps: DeliveryDeps) {
  const { notifications, deviceTokens, preferences, push, now = () => new Date() } = deps;

  return async function deliver(
    eventType: string,
    notification: Omit<Notification, 'readAt'>,
    message: PushMessage
  ): Promise<HandlerResult> {
    const { id, recipientId } = notification;
    const pushWanted = await wantsPush(preferences, recipientId, notification.type);
    // An account that turned the type off has no use for its tokens.
    const tokens = pushWanted ? await deviceTokens.activeTokensOf(recipientId) : [];
    const added = await notifications.add(notification);
    if (!added) {
      logEvent('info', 'Duplicate event dropped', { id, type: eventType });
      return 'ack';
    }
    if (!pushWanted) {
      logEvent('info', 'Push turned off by the recipient', { id, type: eventType });
      return 'ack';
    }
    if (tokens.length === 0) {
      logEvent('info', 'No device to push to', { id, type: eventType });
      return 'ack';
    }

    let invalidTokens: string[];
    try {
      ({ invalidTokens } = await push.send(tokens, message));
    } catch (error) {
      logEvent('warn', 'Push not sent', {
        id,
        type: eventType,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return 'ack';
    }
    logEvent('info', 'Push sent', { id, type: eventType, devices: String(tokens.length) });

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
