import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

import type { PushSender } from '../app/push';
import type { PushConfig } from '../config';
import { logEvent } from './telemetry';

// The most tokens FCM takes in one multicast.
const FCM_BATCH_SIZE = 500;

// What FCM answers for a token that will never get anything again: the app was
// uninstalled or the token expired, or it was never one. Any other failure
// (quota, an outage, a bad credential) says nothing about the device.
const GONE: Record<string, true> = {
  'messaging/registration-token-not-registered': true,
  'messaging/invalid-registration-token': true,
};

/**
 * Development and tests: prints the push instead of sending it, and never
 * reports a token as invalid. The tokens themselves are not printed, only how
 * many there are. Never selected in production.
 */
export function createConsolePushSender(): PushSender {
  return {
    async send(tokens, { title, body, data }) {
      console.info(
        `Push for ${tokens.length} device(s) (console sender, not delivered): ${title}: ${body}`,
        data
      );
      return { invalidTokens: [] };
    },
  };
}

/** The slice of firebase-admin's Messaging this adapter uses, so tests can stand in for it. */
export type FcmClient = Pick<Messaging, 'sendEachForMulticast'>;

export function createFcmPushSender(client: FcmClient): PushSender {
  return {
    async send(tokens, { title, body, data }) {
      const invalidTokens: string[] = [];
      for (let start = 0; start < tokens.length; start += FCM_BATCH_SIZE) {
        const batch = tokens.slice(start, start + FCM_BATCH_SIZE);
        // firebase-admin 14 marks `tokens` deprecated in favour of installation
        // ids, but a registration token is what expo-notifications hands the
        // app, and what E4-H1 asks to store.
        const { responses } = await client.sendEachForMulticast({
          tokens: batch,
          notification: { title, body },
          data,
        });
        // One response per token, in the same order. Only a failed one carries an error.
        responses.forEach(({ error }, i) => {
          if (!error) {
            return;
          }
          if (GONE[error.code] === true) {
            invalidTokens.push(batch[i]);
          } else {
            logEvent('warn', 'Push not delivered to a device', { code: error.code });
          }
        });
      }
      return { invalidTokens };
    },
  };
}

export function createPushSender(config: PushConfig): PushSender {
  return config.provider === 'fcm'
    ? createFcmPushSender(getMessaging(initializeApp({ credential: cert(config.serviceAccount) })))
    : createConsolePushSender();
}
