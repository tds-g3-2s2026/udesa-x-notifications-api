import { describe, expect, it, vi } from 'vitest';

import { EVENT_TYPES, routeEvents, type EventHandler } from '../../src/app/events';
import { exampleEvent } from '../support/contracts';

function setup() {
  const email = vi.fn<EventHandler>(async () => 'ack');
  const userDeleted = vi.fn<EventHandler>(async () => 'ack');
  const followCreated = vi.fn<EventHandler>(async () => 'ack');
  return {
    email,
    userDeleted,
    followCreated,
    route: routeEvents({ email, userDeleted, followCreated }),
  };
}

describe('event routing', () => {
  it('binds the queue to the four email events, user.deleted and follow.created', () => {
    expect(EVENT_TYPES).toEqual([
      'user.registered.v1',
      'email_verification.requested.v1',
      'password.reset_requested.v1',
      'password.changed.v1',
      'user.deleted.v1',
      'follow.created.v1',
    ]);
  });

  it.each([
    ['user.deleted.v1', 'userDeleted'],
    ['follow.created.v1', 'followCreated'],
  ] as const)(
    'hands a %s to its own handler, body untouched, and answers what it answers',
    async (type, own) => {
      const handlers = setup();
      handlers[own].mockResolvedValueOnce('dead-letter');
      const body = JSON.stringify(exampleEvent(type));

      await expect(handlers.route(body)).resolves.toBe('dead-letter');

      expect(handlers[own]).toHaveBeenCalledExactlyOnceWith(body);
      for (const other of ['email', 'userDeleted', 'followCreated'] as const) {
        if (other !== own) {
          expect(handlers[other]).not.toHaveBeenCalled();
        }
      }
    }
  );

  it.each([
    ['an email event', JSON.stringify(exampleEvent('password.changed.v1'))],
    ['an unknown type', JSON.stringify({ id: '1', type: 'post.created.v1' })],
    ['a type named like a property of every object', JSON.stringify({ type: 'constructor' })],
    ['invalid JSON', '{nope'],
    ['JSON null', 'null'],
  ])('hands %s to the email handler, as before', async (_, body) => {
    const { email, userDeleted, followCreated, route } = setup();

    await route(body);

    expect(email).toHaveBeenCalledWith(body);
    expect(userDeleted).not.toHaveBeenCalled();
    expect(followCreated).not.toHaveBeenCalled();
  });
});
