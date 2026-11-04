import type { BatchResponse, SendResponse } from 'firebase-admin/messaging';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createConsolePushSender,
  createFcmPushSender,
  createPushSender,
  type FcmClient,
} from '../../src/infrastructure/push-senders';

const MESSAGE = {
  title: 'Nuevo seguidor',
  body: '@juanperez te empezó a seguir',
  data: { type: 'follow', actorId: '0f8c2a5e-4b7d-4e1a-9c3f-2d6b8a1e5f70' },
};

const ok = (): SendResponse => ({ success: true, messageId: 'projects/p/messages/1' });
const failed = (code: string) =>
  ({ success: false, error: { code, message: code } }) as unknown as SendResponse;

/** FCM as a double: answers each batch with `answer(tokens)`, one response per token. */
function fakeFcm(answer: (tokens: string[]) => SendResponse[] = (tokens) => tokens.map(ok)) {
  const sendEachForMulticast = vi.fn(async ({ tokens }: { tokens: string[] }) => {
    const responses = answer(tokens);
    return {
      responses,
      successCount: responses.filter((r) => r.success).length,
      failureCount: responses.filter((r) => !r.success).length,
    } satisfies BatchResponse;
  });
  return { client: { sendEachForMulticast } as unknown as FcmClient, sendEachForMulticast };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('console push sender', () => {
  it('prints the push and how many devices, never the tokens', async () => {
    const result = await createConsolePushSender().send(['fcm-secret-1', 'fcm-secret-2'], MESSAGE);

    const [line, data] = vi.mocked(console.info).mock.calls[0];
    expect(line).toContain('2 device(s)');
    expect(line).toContain(MESSAGE.title);
    expect(line).toContain(MESSAGE.body);
    expect(line).not.toContain('fcm-secret');
    expect(data).toEqual(MESSAGE.data);
    expect(result).toEqual({ invalidTokens: [] });
  });
});

describe('FCM push sender', () => {
  it('E4-H1.CA1 sends the title, the body and the data to every token through FCM', async () => {
    const { client, sendEachForMulticast } = fakeFcm();

    const result = await createFcmPushSender(client).send(['a', 'b'], MESSAGE);

    expect(sendEachForMulticast).toHaveBeenCalledExactlyOnceWith({
      tokens: ['a', 'b'],
      notification: { title: MESSAGE.title, body: MESSAGE.body },
      data: MESSAGE.data,
    });
    expect(result).toEqual({ invalidTokens: [] });
  });

  it('reports the tokens FCM says no longer exist, and only those', async () => {
    const { client } = fakeFcm(() => [
      ok(),
      failed('messaging/registration-token-not-registered'),
      failed('messaging/invalid-registration-token'),
      failed('messaging/server-unavailable'),
    ]);

    const result = await createFcmPushSender(client).send(['live', 'gone', 'bad', 'busy'], MESSAGE);

    expect(result).toEqual({ invalidTokens: ['gone', 'bad'] });
  });

  it('logs any other failure with its code and without the token', async () => {
    const { client } = fakeFcm(() => [failed('messaging/server-unavailable')]);

    await createFcmPushSender(client).send(['fcm-secret'], MESSAGE);

    expect(console.warn).toHaveBeenCalledExactlyOnceWith('Push not delivered to a device', {
      code: 'messaging/server-unavailable',
    });
  });

  it('sends more than 500 tokens in batches, matching each answer to its token', async () => {
    const tokens = Array.from({ length: 501 }, (_, i) => `t${i}`);
    const { client, sendEachForMulticast } = fakeFcm((batch) =>
      batch.map((token) =>
        token === 't500' ? failed('messaging/registration-token-not-registered') : ok()
      )
    );

    const result = await createFcmPushSender(client).send(tokens, MESSAGE);

    expect(sendEachForMulticast.mock.calls.map(([m]) => m.tokens.length)).toEqual([500, 1]);
    expect(result).toEqual({ invalidTokens: ['t500'] });
  });

  it('rejects when FCM cannot be reached at all', async () => {
    const { client, sendEachForMulticast } = fakeFcm();
    sendEachForMulticast.mockRejectedValueOnce(
      new Error('getaddrinfo ENOTFOUND fcm.googleapis.com')
    );

    await expect(createFcmPushSender(client).send(['a'], MESSAGE)).rejects.toThrow('ENOTFOUND');
  });
});

describe('createPushSender', () => {
  it('prints instead of sending when the config names the console', async () => {
    const result = await createPushSender({ provider: 'console' }).send(['a'], MESSAGE);

    expect(console.info).toHaveBeenCalledOnce();
    expect(result).toEqual({ invalidTokens: [] });
  });

  it('stops the start when the private key of the service account cannot be read', () => {
    const build = () =>
      createPushSender({
        provider: 'fcm',
        serviceAccount: {
          projectId: 'udesa-x',
          clientEmail: 'notifications@udesa-x.iam.gserviceaccount.com',
          privateKey: 'not-a-pem-key',
        },
      });

    expect(build).toThrow('Failed to parse private key');
    expect(build).not.toThrow('not-a-pem-key');
  });
});
