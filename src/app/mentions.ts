import { logEvent } from '../infrastructure/telemetry';
import { actorName, createNotificationDelivery, type DeliveryDeps } from './delivery';
import type { HandlerResult } from './events';

export const MENTION_CREATED = 'mention.created.v1';

/** The most the push quotes of the post, the `…` that marks a cut included. */
export const PREVIEW_LENGTH = 100;

interface MentionCreated {
  id: string;
  authorId: string;
  authorHandle: string | null;
  mentionedId: string;
  postId: string;
  content: string;
  createdAt: Date;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

// Anything that is not an object reads as one with no fields, so the checks
// below name the first field that is missing.
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

// Keep in step with contracts/events/mention.created.v1.json.
function parseMentionCreated(body: string): MentionCreated | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { error: 'body is not valid JSON' };
  }
  const envelope = asRecord(json);
  const data = asRecord(envelope.data);
  if (!isText(envelope.id)) {
    return { error: 'missing id' };
  }
  if (envelope.type !== MENTION_CREATED) {
    return { error: 'not a mention.created.v1 event' };
  }
  const createdAt = new Date(isText(envelope.time) ? envelope.time : Number.NaN);
  if (Number.isNaN(createdAt.getTime())) {
    return { error: 'missing time' };
  }
  if (!isText(data.author_id)) {
    return { error: 'missing data.author_id' };
  }
  if (!isText(data.mentioned_id)) {
    return { error: 'missing data.mentioned_id' };
  }
  if (!isText(data.post_id)) {
    return { error: 'missing data.post_id' };
  }
  if (!isText(data.content)) {
    return { error: 'missing data.content' };
  }
  return {
    id: envelope.id,
    // Account ids are stored the way requireAccount hands them: lowercase.
    authorId: data.author_id.toLowerCase(),
    mentionedId: data.mentioned_id.toLowerCase(),
    postId: data.post_id,
    content: data.content,
    // Only the text uses it: a handle posts-api did not know is no reason to
    // drop the event.
    authorHandle: isText(data.author_handle) ? data.author_handle : null,
    createdAt,
  };
}

/**
 * The start of the post, for the push. A text that fits in `PREVIEW_LENGTH`
 * goes whole. A longer one is cut at the end of a word, never inside it, and
 * gets a `…` so it does not read as complete: the result is never longer than
 * `PREVIEW_LENGTH`. A single word longer than that has no end to cut at, so it
 * is cut where it stands. Line breaks become spaces: a push is one line.
 */
export function previewOf(content: string): string {
  const text = content.trim().replace(/\s+/g, ' ');
  // Counted in characters and not in UTF-16 units, so an emoji is never cut in half.
  const characters = [...text];
  if (characters.length <= PREVIEW_LENGTH) {
    return text;
  }
  // One place is left for the `…`.
  const room = PREVIEW_LENGTH - 1;
  const head = characters.slice(0, room);
  const lastSpace = head.lastIndexOf(' ');
  // Cut right there when the next character is a space, since the cut already falls between
  // two words, or when there is no space to go back to: one word longer than the preview.
  const cutHere = characters[room] === ' ' || lastSpace === -1;
  const kept = cutHere ? head : head.slice(0, lastSpace);
  return `${kept.join('').trimEnd()}…`;
}

/**
 * A mention in a post or a reply: an entry in the center of the mentioned
 * account, and a push to every device of that account, through the shared
 * delivery. posts-api already leaves out the mentions nobody should hear about
 * (of oneself, by an account the mentioned one muted or blocked).
 */
export function createMentionCreatedHandler(deps: DeliveryDeps) {
  const deliver = createNotificationDelivery(deps);

  return async function handle(body: string): Promise<HandlerResult> {
    const event = parseMentionCreated(body);
    if ('error' in event) {
      logEvent('warn', 'Discarding event that cannot be handled', {
        reason: event.error,
        type: MENTION_CREATED,
      });
      return 'dead-letter';
    }

    const { id, authorId, authorHandle, mentionedId, postId, content, createdAt } = event;
    return deliver(
      MENTION_CREATED,
      {
        id,
        recipientId: mentionedId,
        type: 'mention',
        actor: { id: authorId, handle: authorHandle },
        postId,
        replyId: null,
        createdAt,
      },
      {
        title: 'Nueva mención',
        body: `${actorName(authorHandle)} te mencionó: ${previewOf(content)}`,
        // What the app opens on a tap: the post that has the mention. For a
        // reply that is the reply itself, which is where the account was named.
        data: { type: 'mention', postId },
      }
    );
  };
}
