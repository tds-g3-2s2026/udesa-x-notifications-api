import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config';

const URLS = {
  MONGODB_URL: 'mongodb://mongodb:27017/notifications',
  RABBITMQ_URL: 'amqp://user:pass@rabbitmq:5672',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----\n',
};

describe('loadConfig', () => {
  it('reads the URLs and the key, defaults the port to 8000 and prints emails and pushes', () => {
    expect(loadConfig(URLS)).toEqual({
      port: 8000,
      mongodbUrl: URLS.MONGODB_URL,
      rabbitmqUrl: URLS.RABBITMQ_URL,
      email: { provider: 'console', from: 'UdeSA-X <no-reply@udesax.app>' },
      push: { provider: 'console' },
      auth: { jwtPublicKey: URLS.JWT_PUBLIC_KEY, jwtIssuer: 'users-api' },
    });
  });

  it('takes the port from PORT', () => {
    expect(loadConfig({ ...URLS, PORT: '9000' }).port).toBe(9000);
  });

  it('takes the issuer from JWT_ISSUER', () => {
    expect(loadConfig({ ...URLS, JWT_ISSUER: 'users-api-staging' }).auth.jwtIssuer).toBe(
      'users-api-staging'
    );
  });

  it('names every missing variable at once', () => {
    expect(() => loadConfig({})).toThrow(
      'Missing required environment variables: MONGODB_URL, RABBITMQ_URL, JWT_PUBLIC_KEY'
    );
  });

  it('treats an empty variable as missing', () => {
    expect(() => loadConfig({ ...URLS, RABBITMQ_URL: '' })).toThrow(
      'Missing required environment variables: RABBITMQ_URL'
    );
  });
});

describe('loadConfig email', () => {
  it('keeps the console provider when EMAIL_PROVIDER is empty', () => {
    expect(loadConfig({ ...URLS, EMAIL_PROVIDER: '' }).email.provider).toBe('console');
  });

  it('takes the sender address from EMAIL_FROM', () => {
    const { email } = loadConfig({ ...URLS, EMAIL_FROM: 'Test <test@udesax.app>' });

    expect(email.from).toBe('Test <test@udesax.app>');
  });

  it('uses Resend with its key', () => {
    expect(
      loadConfig({ ...URLS, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_123' }).email
    ).toEqual({ provider: 'resend', apiKey: 're_123', from: 'UdeSA-X <no-reply@udesax.app>' });
  });

  it('does not start with Resend and no key', () => {
    expect(() => loadConfig({ ...URLS, EMAIL_PROVIDER: 'resend' })).toThrow(
      'RESEND_API_KEY is required when EMAIL_PROVIDER=resend'
    );
    expect(() => loadConfig({ ...URLS, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: '' })).toThrow(
      'RESEND_API_KEY is required when EMAIL_PROVIDER=resend'
    );
  });

  it('does not need the key with the console provider', () => {
    expect(() => loadConfig({ ...URLS, EMAIL_PROVIDER: 'console' })).not.toThrow();
  });

  it('rejects an unknown provider', () => {
    expect(() => loadConfig({ ...URLS, EMAIL_PROVIDER: 'smtp' })).toThrow(
      "EMAIL_PROVIDER must be 'console' or 'resend', got 'smtp'"
    );
  });
});

describe('loadConfig push', () => {
  const SERVICE_ACCOUNT = {
    type: 'service_account',
    project_id: 'udesa-x',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
    client_email: 'notifications@udesa-x.iam.gserviceaccount.com',
  };

  it('keeps the console provider when PUSH_PROVIDER is empty', () => {
    expect(loadConfig({ ...URLS, PUSH_PROVIDER: '' }).push).toEqual({ provider: 'console' });
  });

  it('uses FCM with the fields of the key file as Firebase hands it', () => {
    const env = {
      ...URLS,
      PUSH_PROVIDER: 'fcm',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SERVICE_ACCOUNT),
    };

    expect(loadConfig(env).push).toEqual({
      provider: 'fcm',
      serviceAccount: {
        projectId: 'udesa-x',
        clientEmail: 'notifications@udesa-x.iam.gserviceaccount.com',
        privateKey: SERVICE_ACCOUNT.private_key,
      },
    });
  });

  it('does not start with FCM and no service account', () => {
    expect(() => loadConfig({ ...URLS, PUSH_PROVIDER: 'fcm' })).toThrow(
      'FIREBASE_SERVICE_ACCOUNT is required when PUSH_PROVIDER=fcm'
    );
  });

  it('does not start with a service account that is not JSON, without echoing it', () => {
    const start = () =>
      loadConfig({ ...URLS, PUSH_PROVIDER: 'fcm', FIREBASE_SERVICE_ACCOUNT: 'private-key-here' });

    expect(start).toThrow('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    expect(start).not.toThrow('private-key-here');
  });

  it.each([
    ['without private_key', { ...SERVICE_ACCOUNT, private_key: undefined }],
    ['that is not an object', 'udesa-x'],
    ['that is null', null],
  ])('does not start with a service account %s', (_, account) => {
    expect(() =>
      loadConfig({
        ...URLS,
        PUSH_PROVIDER: 'fcm',
        FIREBASE_SERVICE_ACCOUNT: JSON.stringify(account),
      })
    ).toThrow('FIREBASE_SERVICE_ACCOUNT must have project_id, client_email and private_key');
  });

  it('rejects an unknown provider', () => {
    expect(() => loadConfig({ ...URLS, PUSH_PROVIDER: 'apns' })).toThrow(
      "PUSH_PROVIDER must be 'console' or 'fcm', got 'apns'"
    );
  });
});
