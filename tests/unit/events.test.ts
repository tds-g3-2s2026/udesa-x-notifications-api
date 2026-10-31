import { describe, expect, it, vi } from 'vitest';

import { EVENT_TYPES, routeEvents, type EventHandler } from '../../src/app/events';
import { exampleEvent } from '../support/contracts';

function setup() {
  const email = vi.fn<EventHandler>(async () => 'ack');
  const userDeleted = vi.fn<EventHandler>(async () => 'ack');
  return { email, userDeleted, route: routeEvents({ email, userDeleted }) };
}

describe('event routing', () => {
  it('binds the queue to the four email events and to user.deleted', () => {
    expect(EVENT_TYPES).toEqual([
      'user.registered.v1',
      'email_verification.requested.v1',
      'password.reset_requested.v1',
      'password.changed.v1',
      'user.deleted.v1',
    ]);
  });

  it('hands a user.deleted to its handler, body untouched, and answers what it answers', async () => {
    const { email, userDeleted, route } = setup();
    userDeleted.mockResolvedValueOnce('dead-letter');
    const body = JSON.stringify(exampleEvent('user.deleted.v1'));

    await expect(route(body)).resolves.toBe('dead-letter');

    expect(userDeleted).toHaveBeenCalledWith(body);
    expect(email).not.toHaveBeenCalled();
  });

  it.each([
    ['an email event', JSON.stringify(exampleEvent('password.changed.v1'))],
    ['an unknown type', JSON.stringify({ id: '1', type: 'post.created.v1' })],
    ['invalid JSON', '{nope'],
    ['JSON null', 'null'],
  ])('hands %s to the email handler, as before', async (_, body) => {
    const { email, userDeleted, route } = setup();

    await route(body);

    expect(email).toHaveBeenCalledWith(body);
    expect(userDeleted).not.toHaveBeenCalled();
  });
});
