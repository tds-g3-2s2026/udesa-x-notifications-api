import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailMessage, EmailSender } from '../../src/app/email';
import {
  createEmailEventHandler,
  EMAIL_EVENT_TYPES,
  type EmailRecord,
  type EmailStore,
} from '../../src/app/email-events';
import { exampleEvent } from '../support/contracts';

// Same contract as the MongoDB store: one record per id, the insert reports a
// duplicate instead of overwriting.
function fakeStore() {
  const records = new Map<string, EmailRecord>();
  const store: EmailStore = {
    async insertPending(record) {
      const existing = records.get(record._id);
      if (existing) {
        return existing.status;
      }
      records.set(record._id, { ...record });
      return null;
    },
    async finish(id, status, sentAt) {
      Object.assign(records.get(id)!, { status, sent_at: sentAt });
    },
  };
  return { store, records };
}

function fakeSender(send: EmailSender['send'] = async () => {}) {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    async send(message) {
      await send(message);
      sent.push(message);
    },
  };
  return { sender, sent };
}

const NOW = new Date('2026-10-24T12:00:00Z');

function setup(send?: EmailSender['send']) {
  const { store, records } = fakeStore();
  const { sender, sent } = fakeSender(send);
  const handle = createEmailEventHandler({ store, sender, now: () => NOW });
  return { handle, records, sent, store };
}

const body = (event: unknown) => JSON.stringify(event);

let logged: () => string;

beforeEach(() => {
  vi.restoreAllMocks();
  const spies = (['info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {})
  );
  logged = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
});

describe('email event handler', () => {
  it('handles exactly the four events of the contract', () => {
    expect(EMAIL_EVENT_TYPES).toEqual([
      'user.registered.v1',
      'email_verification.requested.v1',
      'password.reset_requested.v1',
      'password.changed.v1',
    ]);
  });

  it.each(['user.registered.v1', 'email_verification.requested.v1'])(
    'sends the verification email for %s',
    async (type) => {
      const { handle, sent } = setup();
      const event = exampleEvent(type);

      await expect(handle(body(event))).resolves.toBe('ack');

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(event.data.email);
      expect(sent[0].subject).toBe('Validá tu cuenta de UdeSA-X');
      expect(sent[0].text).toContain(event.data.verification_url);
    }
  );

  it('sends the recovery email with the token for password.reset_requested.v1', async () => {
    const { handle, sent } = setup();
    const event = exampleEvent('password.reset_requested.v1');

    await handle(body(event));

    expect(sent).toEqual([
      expect.objectContaining({
        to: event.data.email,
        subject: 'Recuperá tu contraseña de UdeSA-X',
      }),
    ]);
    expect(sent[0].text).toContain(event.data.token);
  });

  it('sends the notice for password.changed.v1', async () => {
    const { handle, sent } = setup();
    const event = exampleEvent('password.changed.v1');

    await handle(body(event));

    expect(sent).toEqual([
      expect.objectContaining({
        to: event.data.email,
        subject: 'La contraseña de tu cuenta de UdeSA-X cambió',
      }),
    ]);
  });

  it('records who and what, and never the link, the token or the body', async () => {
    const { handle, records } = setup();
    const event = exampleEvent('user.registered.v1');

    await handle(body(event));

    expect(records.get(event.id)).toEqual({
      _id: event.id,
      type: 'user.registered.v1',
      user_id: event.data.user_id,
      to: event.data.email,
      status: 'sent',
      created_at: NOW,
      sent_at: NOW,
    });
    expect(JSON.stringify([...records.values()])).not.toContain(event.data.verification_url);
  });

  it('drops a duplicate of a sent email', async () => {
    const { handle, sent } = setup();
    const event = exampleEvent('password.changed.v1');

    await handle(body(event));
    await expect(handle(body(event))).resolves.toBe('ack');

    expect(sent).toHaveLength(1);
  });

  it('sends once when the same event is handled at the same time', async () => {
    const { handle, sent } = setup(() => new Promise((resolve) => setTimeout(resolve, 20)));
    const event = exampleEvent('password.changed.v1');

    const results = await Promise.all([handle(body(event)), handle(body(event))]);

    expect(results).toEqual(['ack', 'ack']);
    expect(sent).toHaveLength(1);
  });

  it('sends again an email left pending by an attempt that died mid-send', async () => {
    const { handle, records, sent, store } = setup();
    const event = exampleEvent('password.changed.v1');
    await store.insertPending({
      _id: event.id,
      type: event.type,
      user_id: event.data.user_id,
      to: event.data.email,
      status: 'pending',
      created_at: NOW,
      sent_at: null,
    });

    await expect(handle(body(event))).resolves.toBe('ack');

    expect(sent).toHaveLength(1);
    expect(records.get(event.id)?.status).toBe('sent');
  });

  describe('when the provider rejects the email', () => {
    const reject = async () => {
      throw new Error("Resend did not accept the mail 'x' for a@b.c: validation_error nope");
    };

    it('marks it failed and acks, without sending anything else', async () => {
      const { handle, records } = setup(reject);
      const event = exampleEvent('user.registered.v1');

      await expect(handle(body(event))).resolves.toBe('ack');

      expect(records.get(event.id)).toMatchObject({ status: 'failed', sent_at: null });
    });

    it('does not retry a failed email when the event comes again', async () => {
      const send = vi.fn(reject);
      const { handle } = setup(send);
      const event = exampleEvent('user.registered.v1');

      await handle(body(event));
      await expect(handle(body(event))).resolves.toBe('ack');

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('logs the failure without the secrets of the email', async () => {
      const { handle } = setup(reject);
      const event = exampleEvent('user.registered.v1');

      await handle(body(event));

      expect(logged()).toContain('Email not sent');
      expect(logged()).not.toContain(event.data.verification_url);
    });
  });

  describe('a message that can never be handled', () => {
    const valid = () => exampleEvent('password.reset_requested.v1');

    it.each([
      ['is not JSON', 'not json {'],
      ['is not an object', '[1, 2]'],
      ['has no id', body({ ...valid(), id: undefined })],
      ['has no type', body({ ...valid(), type: undefined })],
      ['has an unknown type', body({ ...valid(), type: 'user.deleted.v1' })],
      ['has no data', body({ ...valid(), data: undefined })],
      ['has no email', body({ ...valid(), data: { ...valid().data, email: undefined } })],
      [
        'has no token',
        body({ ...valid(), data: { user_id: valid().data.user_id, email: 'a@b.c' } }),
      ],
      ['has an empty token', body({ ...valid(), data: { ...valid().data, token: '' } })],
      ['has a token that is not text', body({ ...valid(), data: { ...valid().data, token: 7 } })],
    ])('goes to the dead-letter queue when it %s', async (_name, message) => {
      const { handle, sent, records } = setup();

      await expect(handle(message)).resolves.toBe('dead-letter');

      expect(sent).toHaveLength(0);
      expect(records.size).toBe(0);
    });

    it('is logged as a warning without its content', async () => {
      const { handle } = setup();
      const event = valid();

      await handle(body({ ...event, data: { ...event.data, email: undefined } }));

      expect(logged()).toContain('missing data.email');
      expect(logged()).not.toContain(event.data.token);
    });
  });

  it('throws when the store fails, so the message is requeued', async () => {
    const { handle, store, sent } = setup();
    store.insertPending = async () => {
      throw new Error('connect ECONNREFUSED');
    };

    await expect(handle(body(exampleEvent('password.changed.v1')))).rejects.toThrow(
      'connect ECONNREFUSED'
    );
    expect(sent).toHaveLength(0);
  });

  it('throws when the result cannot be saved, so the message is requeued', async () => {
    const { handle, store } = setup();
    store.finish = async () => {
      throw new Error('connection closed');
    };

    await expect(handle(body(exampleEvent('password.changed.v1')))).rejects.toThrow(
      'connection closed'
    );
  });
});
