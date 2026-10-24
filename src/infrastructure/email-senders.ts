import { Resend } from 'resend';

import type { EmailMessage, EmailSender } from '../app/email';
import type { EmailConfig } from '../config';

// users-api used the same limit; the SDK's own is 30 s.
const RESEND_TIMEOUT_MS = 5000;

/**
 * Development and tests: prints the mail, link or code included, instead of
 * sending it. It writes to the console and not through `logEvent`, so what is
 * printed never goes out over OTLP. Never selected in production.
 */
export function createConsoleEmailSender(): EmailSender {
  return {
    async send({ to, subject, text }: EmailMessage) {
      console.info(`Email for ${to} (console sender, not delivered): ${subject}\n${text}`);
    },
  };
}

/** The slice of the Resend SDK this adapter uses, so tests can stand in for it. */
export type ResendClient = Pick<Resend, 'emails'>;

export function createResendEmailSender(client: ResendClient, from: string): EmailSender {
  return {
    async send({ to, subject, text }: EmailMessage) {
      // The SDK reports a rejection as a value and a network failure or the
      // timeout as that same kind of value, so there is one path below.
      const { error } = await client.emails.send(
        { from, to, subject, text },
        { signal: AbortSignal.timeout(RESEND_TIMEOUT_MS) }
      );
      if (error) {
        // The body carries a one-time link or code: only the subject and the
        // recipient go in the message.
        throw new Error(
          `Resend did not accept the mail '${subject}' for ${to}: ${error.name} ${error.message}`
        );
      }
    },
  };
}

export function createEmailSender(config: EmailConfig): EmailSender {
  return config.provider === 'resend'
    ? createResendEmailSender(new Resend(config.apiKey), config.from)
    : createConsoleEmailSender();
}
