import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceTokenStore } from '../../src/app/device-tokens';
import { PREVIEW_LENGTH, createMentionCreatedHandler, previewOf } from '../../src/app/mentions';
import type { NotificationStore } from '../../src/app/notifications';
import type { PreferenceStore } from '../../src/app/preferences';
import type { PushSender } from '../../src/app/push';
import { exampleEvent, type EventEnvelope } from '../support/contracts';

function setup({ isNew = true } = {}) {
  const deviceTokens = {
    register: vi.fn(),
    activeTokensOf: vi.fn<DeviceTokenStore['activeTokensOf']>(async () => ['phone']),
    softDelete: vi.fn<DeviceTokenStore['softDelete']>(async () => {}),
    softDeleteOwnedBy: vi.fn(),
  } satisfies DeviceTokenStore;
  const notifications = {
    add: vi.fn<NotificationStore['add']>(async () => isNew),
    page: vi.fn(),
    markAllRead: vi.fn(),
    softDelete: vi.fn(),
    softDeleteOwnedBy: vi.fn(),
  } satisfies NotificationStore;
  // An account that never chose: everything on.
  const preferences = {
    chosenBy: vi.fn<PreferenceStore['chosenBy']>(async () => ({})),
    set: vi.fn(),
    deleteOwnedBy: vi.fn(),
  } satisfies PreferenceStore;
  const push = {
    send: vi.fn<PushSender['send']>(async () => ({ invalidTokens: [] })),
  } satisfies PushSender;
  const handle = createMentionCreatedHandler({ notifications, deviceTokens, preferences, push });
  return { handle, deviceTokens, notifications, push };
}

/** The first example of the schema, with `content` as the text when given. */
function event(content?: string): EventEnvelope {
  const mention = exampleEvent('mention.created.v1');
  if (content !== undefined) {
    mention.data.content = content;
  }
  return mention;
}

/** The same mention with one thing different, which may be missing altogether. */
function withData(change: Record<string, string | undefined>): string {
  const mention = event();
  return JSON.stringify({ ...mention, data: { ...mention.data, ...change } });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('preview of a post', () => {
  it('quotes a text that fits whole, even at exactly 100 characters', () => {
    const exact = 'a'.repeat(PREVIEW_LENGTH);

    expect(previewOf('Hola, ¿venís hoy?')).toBe('Hola, ¿venís hoy?');
    expect(previewOf(exact)).toBe(exact);
  });

  it('cuts a longer text at the end of a word and marks the cut, in 100 characters or less', () => {
    const text = 'palabra '.repeat(30).trim();

    const preview = previewOf(text);

    expect(preview).toBe(`${'palabra '.repeat(11)}palabra…`);
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_LENGTH);
  });

  it('keeps the last word when the cut falls right after it', () => {
    // Words of 4 letters: the 100th character is a space, so the first 99 end a word.
    const text = 'xxxx '.repeat(30).trim();

    expect(previewOf(text)).toBe(`${'xxxx '.repeat(19)}xxxx…`);
  });

  it('cuts a single word longer than the preview where it stands', () => {
    const preview = previewOf('x'.repeat(250));

    expect(preview).toBe(`${'x'.repeat(PREVIEW_LENGTH - 1)}…`);
  });

  it('turns line breaks and runs of spaces into one space, and trims the ends', () => {
    expect(previewOf('  Hola\n\nmundo   cruel \n')).toBe('Hola mundo cruel');
  });

  it('counts characters and not UTF-16 units, so an emoji is never cut in half', () => {
    const preview = previewOf('😀'.repeat(150));

    expect([...preview]).toHaveLength(PREVIEW_LENGTH);
    expect(preview).toBe(`${'😀'.repeat(PREVIEW_LENGTH - 1)}…`);
  });
});

describe('mention.created handler', () => {
  it('says who mentioned and quotes the post', async () => {
    const { handle, deviceTokens, push } = setup();
    const mention = event('Gran charla de @mariagomez hoy');

    await expect(handle(JSON.stringify(mention))).resolves.toBe('ack');

    expect(deviceTokens.activeTokensOf).toHaveBeenCalledWith(mention.data.mentioned_id);
    expect(push.send).toHaveBeenCalledWith(
      ['phone'],
      expect.objectContaining({
        title: 'Nueva mención',
        body: '@juanperez te mencionó: Gran charla de @mariagomez hoy',
      })
    );
  });

  it('opens the post that has the mention, which for a reply is the reply', async () => {
    const { handle, push } = setup();
    const mention = event();

    await handle(JSON.stringify(mention));

    expect(push.send.mock.calls[0][1].data).toEqual({
      type: 'mention',
      postId: mention.data.post_id,
    });
  });

  it('adds the entry to the center of the mentioned account, with no reply', async () => {
    const { handle, notifications } = setup();
    const mention = event();

    await handle(JSON.stringify(mention));

    expect(notifications.add).toHaveBeenCalledExactlyOnceWith({
      id: mention.id,
      recipientId: mention.data.mentioned_id,
      type: 'mention',
      actor: { id: mention.data.author_id, handle: 'juanperez' },
      postId: mention.data.post_id,
      replyId: null,
      createdAt: new Date(mention.time),
    });
  });

  it('names an author posts-api did not know as somebody', async () => {
    const { handle, push } = setup();

    await handle(withData({ author_handle: undefined }));

    expect(push.send).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ body: expect.stringMatching(/^Alguien te mencionó: /) })
    );
  });

  it('does not double the @ of a handle that already carries it, as users-api handles do', async () => {
    const { handle, push } = setup();

    await handle(withData({ author_handle: '@ana' }));

    expect(push.send).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ body: expect.stringMatching(/^@ana te mencionó: /) })
    );
  });

  it('does not push again for an event whose entry already exists', async () => {
    const { handle, push } = setup({ isNew: false });

    await expect(handle(JSON.stringify(event()))).resolves.toBe('ack');

    expect(push.send).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', '{nope'],
    ['JSON null', 'null'],
    ['another type of event', JSON.stringify({ ...event(), type: 'like.created.v1' })],
    ['no id', JSON.stringify({ ...event(), id: undefined })],
    ['no time', JSON.stringify({ ...event(), time: undefined })],
    ['no author_id', withData({ author_id: undefined })],
    ['no mentioned_id', withData({ mentioned_id: undefined })],
    ['no post_id', withData({ post_id: undefined })],
    ['no content', withData({ content: undefined })],
    ['an empty content', withData({ content: '' })],
  ])('sends %s to the dead letter queue, with nothing recorded or sent', async (_, body) => {
    const { handle, notifications, push } = setup();

    await expect(handle(body)).resolves.toBe('dead-letter');

    expect(notifications.add).not.toHaveBeenCalled();
    expect(push.send).not.toHaveBeenCalled();
  });
});
