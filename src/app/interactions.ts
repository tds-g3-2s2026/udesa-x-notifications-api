import { logEvent } from '../infrastructure/telemetry';
import { actorName, createNotificationDelivery, type DeliveryDeps } from './delivery';
import type { HandlerResult } from './events';

export const INTERACTION_CREATED = 'interaction.created.v1';

interface InteractionCreated {
  id: string;
  kind: string;
  actorId: string;
  actorHandle: string | null;
  postId: string;
  postAuthorId: string;
  replyId: string | null;
  quoteId: string | null;
  createdAt: Date;
}

/**
 * What the push says for each kind. A kind missing here is one posts-api added
 * after this version: the contract asks consumers to ignore it, so it is not an
 * error.
 */
const WORDING: Record<string, { title: string; action: string }> = {
  like: { title: 'Nuevo me gusta', action: 'le dio me gusta a tu publicación' },
  retweet: { title: 'Nuevo retweet', action: 'retuiteó tu publicación' },
  reply: { title: 'Nueva respuesta', action: 'respondió tu publicación' },
  quote: { title: 'Nueva cita', action: 'citó tu publicación' },
};

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

// Anything that is not an object reads as one with no fields, so the checks
// below name the first field that is missing.
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

// Keep in step with contracts/events/interaction.created.v1.json.
function parseInteractionCreated(body: string): InteractionCreated | { error: string } {
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
  if (envelope.type !== INTERACTION_CREATED) {
    return { error: 'not an interaction.created.v1 event' };
  }
  const createdAt = new Date(isText(envelope.time) ? envelope.time : Number.NaN);
  if (Number.isNaN(createdAt.getTime())) {
    return { error: 'missing time' };
  }
  if (!isText(data.kind)) {
    return { error: 'missing data.kind' };
  }
  if (!isText(data.actor_id)) {
    return { error: 'missing data.actor_id' };
  }
  if (!isText(data.post_id)) {
    return { error: 'missing data.post_id' };
  }
  if (!isText(data.post_author_id)) {
    return { error: 'missing data.post_author_id' };
  }
  return {
    id: envelope.id,
    kind: data.kind,
    // Account ids are stored the way requireAccount hands them: lowercase.
    actorId: data.actor_id.toLowerCase(),
    postAuthorId: data.post_author_id.toLowerCase(),
    postId: data.post_id,
    // None of these is needed to notify: a handle posts-api did not know, or a
    // reply or quote id that did not come, is no reason to drop the event.
    actorHandle: isText(data.actor_handle) ? data.actor_handle : null,
    replyId: isText(data.reply_id) ? data.reply_id : null,
    quoteId: isText(data.quote_id) ? data.quote_id : null,
    createdAt,
  };
}

/**
 * A like, retweet, reply or quote on a post: an entry in the center of the post's
 * author, and a push to every device of that account, through the shared
 * delivery. posts-api already leaves out the interactions nobody should hear
 * about (on one's own post, or from an account the author muted).
 */
export function createInteractionCreatedHandler(deps: DeliveryDeps) {
  const deliver = createNotificationDelivery(deps);

  return async function handle(body: string): Promise<HandlerResult> {
    const event = parseInteractionCreated(body);
    if ('error' in event) {
      logEvent('warn', 'Discarding event that cannot be handled', {
        reason: event.error,
        type: INTERACTION_CREATED,
      });
      return 'dead-letter';
    }

    const { id, kind, actorId, actorHandle, postId, postAuthorId, replyId, quoteId, createdAt } =
      event;
    // Own keys only: a kind like "constructor" must not reach Object's.
    const wording = Object.hasOwn(WORDING, kind) ? WORDING[kind] : undefined;
    if (!wording) {
      logEvent('info', 'Interaction kind not handled', { id, kind });
      return 'ack';
    }
    // What the app opens on a tap, from the center and from the push alike: the
    // post that received the interaction, the answered one for a reply. A quote
    // opens the quote, which shows the comment with the quoted post inside; the
    // quoted post alone would not say who quoted it or what they said.
    const opens = kind === 'quote' && quoteId ? quoteId : postId;

    return deliver(
      INTERACTION_CREATED,
      {
        id,
        recipientId: postAuthorId,
        type: kind,
        actor: { id: actorId, handle: actorHandle },
        postId: opens,
        replyId,
        createdAt,
      },
      {
        title: wording.title,
        body: `${actorName(actorHandle)} ${wording.action}`,
        data: { type: kind, postId: opens },
      }
    );
  };
}
