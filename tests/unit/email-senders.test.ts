import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createConsoleEmailSender,
  createEmailSender,
  createResendEmailSender,
  type ResendClient,
} from '../../src/infrastructure/email-senders';

const MESSAGE = {
  to: 'alumno@udesa.edu.ar',
  subject: 'Recuperá tu contraseña de UdeSA-X',
  text: 'Hola,\n\nel código es Xc5vB8nM2kLj6hGf',
};

function fakeResend(result: unknown) {
  const send = vi.fn(async () => result);
  return { client: { emails: { send } } as unknown as ResendClient, send };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('console email sender', () => {
  it('prints the mail with its code or link', async () => {
    await createConsoleEmailSender().send(MESSAGE);

    const [line] = vi.mocked(console.info).mock.calls[0];
    expect(line).toContain(MESSAGE.to);
    expect(line).toContain(MESSAGE.subject);
    expect(line).toContain('Xc5vB8nM2kLj6hGf');
  });
});

describe('Resend email sender', () => {
  it('sends from the configured address, with a 5 s timeout', async () => {
    const { client, send } = fakeResend({ data: { id: 'abc' }, error: null });

    await createResendEmailSender(client, 'UdeSA-X <no-reply@udesax.app>').send(MESSAGE);

    expect(send).toHaveBeenCalledWith(
      {
        from: 'UdeSA-X <no-reply@udesax.app>',
        to: MESSAGE.to,
        subject: MESSAGE.subject,
        text: MESSAGE.text,
      },
      { signal: expect.any(AbortSignal) }
    );
  });

  it('rejects with the subject, the recipient and the reason, never the body', async () => {
    const { client } = fakeResend({
      data: null,
      error: { name: 'validation_error', message: 'Invalid `to` field', statusCode: 422 },
    });

    const sending = createResendEmailSender(client, 'a <a@b.c>').send(MESSAGE);

    await expect(sending).rejects.toThrow(
      `Resend did not accept the mail '${MESSAGE.subject}' for ${MESSAGE.to}: validation_error Invalid \`to\` field`
    );
    await expect(sending).rejects.not.toThrow('Xc5vB8nM2kLj6hGf');
  });
});

describe('createEmailSender', () => {
  it('builds the one the config names', async () => {
    await createEmailSender({ provider: 'console', from: 'a <a@b.c>' }).send(MESSAGE);
    expect(console.info).toHaveBeenCalledOnce();

    expect(createEmailSender({ provider: 'resend', apiKey: 're_x', from: 'a <a@b.c>' })).toEqual({
      send: expect.any(Function),
    });
  });
});
