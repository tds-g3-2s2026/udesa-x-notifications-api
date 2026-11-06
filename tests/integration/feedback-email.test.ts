import { randomUUID } from 'node:crypto';

import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createEmailEventHandler } from '../../src/app/email-events';
import { createResendEmailSender, type ResendClient } from '../../src/infrastructure/email-senders';
import { createEmailStore, emailCollection } from '../../src/infrastructure/email-store';
import { createMongoClient } from '../../src/infrastructure/mongodb';
import { exampleEvent } from '../support/contracts';

// The handler with the real store and the real Resend adapter; only the SDK
// client is a double, so the test sees exactly what would reach the provider.
// That the queue gets the event from the exchange is in email-consumer.test.ts,
// which owns the queue in this suite.
const { MONGODB_URL } = process.env;
if (!MONGODB_URL) {
  throw new Error('tests/integration needs MONGODB_URL');
}

const SUPPORT_EMAIL = 'support@udesax.test';
const FROM = 'UdeSA-X <no-reply@udesax.test>';

let mongo: MongoClient;
const eventIds: string[] = [];

const emails = () => emailCollection(mongo);

function setup() {
  const send = vi.fn(async () => ({ data: { id: 'abc' }, error: null }));
  const client = { emails: { send } } as unknown as ResendClient;
  const handle = createEmailEventHandler({
    store: createEmailStore(emails()),
    sender: createResendEmailSender(client, FROM),
    supportEmail: SUPPORT_EMAIL,
  });
  return { handle, send };
}

function newEvent(message?: string) {
  const event = exampleEvent('feedback.submitted.v1', randomUUID());
  eventIds.push(event.id);
  return message ? { ...event, data: { ...event.data, message } } : event;
}

/** The first argument of the only call to the provider. */
function payload(send: ReturnType<typeof setup>['send']) {
  expect(send).toHaveBeenCalledOnce();
  return (send.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
}

beforeAll(() => {
  mongo = createMongoClient(MONGODB_URL);
});

afterAll(async () => {
  await emails().deleteMany({ _id: { $in: eventIds } });
  await mongo.close();
});

describe('feedback email', () => {
  it('E1-H11.CA2 - emails the support account', async () => {
    const { handle, send } = setup();
    const event = newEvent();

    await expect(handle(JSON.stringify(event))).resolves.toBe('ack');

    const mail = payload(send);
    expect(mail.to).toBe(SUPPORT_EMAIL);
    expect(mail.from).toBe(FROM);
    for (const value of Object.values(event.data)) {
      expect(mail.text).toContain(value);
    }
  });

  it('sends the message as plain text, exactly as the user wrote it', async () => {
    const { handle, send } = setup();
    const message = '<script>alert(1)</script> y <b>negrita</b> & "comillas"';

    await handle(JSON.stringify(newEvent(message)));

    const mail = payload(send);
    expect(Object.keys(mail).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(mail.text).toContain(message);
    expect(mail.subject).not.toContain('<script>');
  });

  it('keeps that it was sent, without the message', async () => {
    const { handle } = setup();
    const event = newEvent();

    await handle(JSON.stringify(event));

    const stored = await emails().findOne({ _id: event.id });
    expect(stored).toMatchObject({
      type: 'feedback.submitted.v1',
      user_id: event.data.user_id,
      to: SUPPORT_EMAIL,
      status: 'sent',
    });
    expect(JSON.stringify(stored)).not.toContain(event.data.message);
  });

  it('sends one email when the same event arrives twice', async () => {
    const { handle, send } = setup();
    const body = JSON.stringify(newEvent());

    await handle(body);
    await expect(handle(body)).resolves.toBe('ack');

    expect(send).toHaveBeenCalledOnce();
  });
});
