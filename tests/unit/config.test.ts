import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config';

const URLS = {
  MONGODB_URL: 'mongodb://mongodb:27017/notifications',
  RABBITMQ_URL: 'amqp://user:pass@rabbitmq:5672',
};

describe('loadConfig', () => {
  it('reads both URLs and defaults the port to 8000', () => {
    expect(loadConfig(URLS)).toEqual({
      port: 8000,
      mongodbUrl: URLS.MONGODB_URL,
      rabbitmqUrl: URLS.RABBITMQ_URL,
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
