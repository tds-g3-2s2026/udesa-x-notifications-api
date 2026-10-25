import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config';

const URLS = {
  MONGODB_URL: 'mongodb://mongodb:27017/notifications',
  RABBITMQ_URL: 'amqp://user:pass@rabbitmq:5672',
};

describe('loadConfig', () => {
  it('reads both URLs, defaults the port to 8000 and sends emails to the console', () => {
    expect(loadConfig(URLS)).toEqual({
      port: 8000,
      mongodbUrl: URLS.MONGODB_URL,
      rabbitmqUrl: URLS.RABBITMQ_URL,
      email: { provider: 'console', from: 'UdeSA-X <no-reply@udesax.app>' },
    });
  });

  it('takes the port from PORT', () => {
    expect(loadConfig({ ...URLS, PORT: '9000' }).port).toBe(9000);
  });

  it('names every missing variable at once', () => {
    expect(() => loadConfig({})).toThrow(
      'Missing required environment variables: MONGODB_URL, RABBITMQ_URL'
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
