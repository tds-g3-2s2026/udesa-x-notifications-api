import { logEvent } from '../infrastructure/telemetry';
import type { EmailMessage, EmailSender } from './email';
import { passwordChangedEmail, passwordResetEmail, verificationEmail } from './email-templates';
import type { HandlerResult } from './events';

export type EmailStatus = 'pending' | 'sent' | 'failed';

/**
 * What is kept of an email: enough to know it was handled, never the body or
 * the secrets in it. `_id` is the id of the event that asked for it.
 */
export interface EmailRecord {
  _id: string;
  type: string;
  user_id: string;
  to: string;
  status: EmailStatus;
  created_at: Date;
  sent_at: Date | null;
}

/**
 * The store works on one document at a time: MongoDB runs here without a
 * replica set, so there are no multi-document transactions.
 */
export interface EmailStore {
  /**
   * Inserts the record. When the id is already there nothing changes and the
   * stored status comes back; `null` means it was inserted.
   */
  insertPending(record: EmailRecord): Promise<EmailStatus | null>;
  finish(id: string, status: 'sent' | 'failed', sentAt: Date | null): Promise<void>;
}

interface EventKind {
  /** Fields of `data` the email needs, besides `user_id` and `email`. */
  fields: string[];
  render(to: string, data: Record<string, string>): EmailMessage;
}

// Keep in step with the schemas in contracts/events/.
const EVENT_KINDS: Record<string, EventKind> = {
  'user.registered.v1': {
    fields: ['verification_url'],
    render: (to, data) => verificationEmail(to, data.verification_url),
  },
  'email_verification.requested.v1': {
    fields: ['verification_url'],
    render: (to, data) => verificationEmail(to, data.verification_url),
  },
  'password.reset_requested.v1': {
    fields: ['token'],
    render: (to, data) => passwordResetEmail(to, data.token),
  },
  'password.changed.v1': {
    fields: [],
    render: (to) => passwordChangedEmail(to),
  },
};

/** The event types that ask for an email. */
export const EMAIL_EVENT_TYPES = Object.keys(EVENT_KINDS);

interface ParsedEvent {
  id: string;
  type: string;
  userId: string;
  to: string;
  message: EmailMessage;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

// A parsed JSON value that is an object. The cast is the whole check: the
// fields are validated one by one by the caller.
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Failures name the field or the type, never a value: the data carries secrets.
function parseEvent(body: string): ParsedEvent | { error: string; type?: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { error: 'body is not valid JSON' };
  }
  const envelope = asRecord(json);
  if (!envelope) {
    return { error: 'body is not a JSON object' };
  }
  const { id, type } = envelope;
  if (!isText(id)) {
    return { error: 'missing id' };
  }
  if (!isText(type)) {
    return { error: 'missing type' };
  }
  if (!Object.hasOwn(EVENT_KINDS, type)) {
    return { error: 'unknown type', type: type.slice(0, 100) };
  }
  const data = asRecord(envelope.data);
  if (!data) {
    return { error: 'missing data', type };
  }
  const kind = EVENT_KINDS[type];
  const text: Record<string, string> = {};
  for (const field of ['user_id', 'email', ...kind.fields]) {
    const value = data[field];
    if (!isText(value)) {
      return { error: `missing data.${field}`, type };
    }
    text[field] = value;
  }
  return { id, type, userId: text.user_id, to: text.email, message: kind.render(text.email, text) };
}

/**
 * Sends the email an event asks for, once per event id.
 *
 * The record in `emails` is the memory of what was done, written before the
 * send and closed after it:
 * - a duplicate that is `sent` or `failed` is dropped;
 * - a duplicate still `pending` means a previous attempt died mid-send, so it
 *   is sent again. The worst case is a repeated email, accepted over losing one.
 *
 * A provider error is not retried here (backoff is T-59): the email is marked
 * `failed` and the message acked. An error from the store is thrown, so the
 * consumer requeues the message.
 *
 * Events with the same id run one after the other inside the process: with
 * several messages in flight, a duplicate would otherwise see the `pending`
 * record of the send still running and send again. Across replicas that window
 * stays open, and costs at most a repeated email.
 */
export function createEmailEventHandler(deps: {
  store: EmailStore;
  sender: EmailSender;
  now?: () => Date;
}) {
  const { store, sender, now = () => new Date() } = deps;
  const running = new Map<string, Promise<HandlerResult>>();

  async function deliver(event: ParsedEvent): Promise<HandlerResult> {
    const { id, type } = event;
    const status = await store.insertPending({
      _id: id,
      type,
      user_id: event.userId,
      to: event.to,
      status: 'pending',
      created_at: now(),
      sent_at: null,
    });
    if (status === 'sent' || status === 'failed') {
      logEvent('info', 'Duplicate event dropped', { id, type, status });
      return 'ack';
    }
    if (status === 'pending') {
      logEvent('warn', 'Resending an email left pending by an earlier attempt', { id, type });
    }

    try {
      await sender.send(event.message);
    } catch (error) {
      logEvent('warn', 'Email not sent', {
        id,
        type,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      await store.finish(id, 'failed', null);
      return 'ack';
    }
    await store.finish(id, 'sent', now());
    return 'ack';
  }

  return async function handle(body: string): Promise<HandlerResult> {
    const parsed = parseEvent(body);
    if ('error' in parsed) {
      logEvent('warn', 'Discarding event that cannot be handled', {
        reason: parsed.error,
        ...(parsed.type ? { type: parsed.type } : {}),
      });
      return 'dead-letter';
    }

    const previous = running.get(parsed.id);
    const turn = (async () => {
      await previous?.catch(() => {});
      return deliver(parsed);
    })();
    running.set(parsed.id, turn);
    try {
      return await turn;
    } finally {
      if (running.get(parsed.id) === turn) {
        running.delete(parsed.id);
      }
    }
  };
}
