import { ProblemError, type FieldError } from './errors';

/**
 * The kinds of notification an account can turn off. The same strings are the
 * `type` of an entry in the center and of a push, so the preference of an entry
 * is found by its own type. `direct_message` has no notifications yet (E3-H6):
 * only its preference is stored.
 */
export const NOTIFICATION_TYPES = [
  'like',
  'retweet',
  'reply',
  'mention',
  'follow',
  'direct_message',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** What an account receives, one answer per type. */
export type Preferences = Record<NotificationType, boolean>;

/**
 * An account that never chose has nothing stored, and everything is on. Only
 * what the account touched is kept, so a type added later starts on for
 * everyone without a migration.
 */
export interface PreferenceStore {
  /** The types the account turned on or off at some point. Reading writes nothing. */
  chosenBy(accountId: string): Promise<Partial<Preferences>>;
  /**
   * Records the given choices as of `at` and leaves the other types as they
   * were. Repeating the call changes nothing else.
   */
  set(accountId: string, changes: Partial<Preferences>, at: Date): Promise<void>;
}

function withDefaults(chosen: Partial<Preferences>): Preferences {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, chosen[type] ?? true])
  ) as Preferences;
}

export async function getPreferences(
  store: PreferenceStore,
  accountId: string
): Promise<Preferences> {
  return withDefaults(await store.chosenBy(accountId));
}

/**
 * Whether the account wants a push of this type. A type the service does not
 * know has no preference to turn off, so it is on: the same as one the account
 * never chose.
 */
export async function wantsPush(
  store: PreferenceStore,
  accountId: string,
  type: string
): Promise<boolean> {
  const chosen: Partial<Record<string, boolean>> = await store.chosenBy(accountId);
  return chosen[type] !== false;
}

const validationFailed = (errors: FieldError[]) =>
  new ProblemError({
    status: 422,
    code: 'validation-failed',
    title: 'La solicitud tiene campos inválidos',
    detail: 'Revisá los campos indicados y volvé a intentar',
    errors,
  });

function isNotificationType(key: string): key is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(key);
}

/**
 * Saves the choices of the account (E4-H5 CA.1). The account is the caller's,
 * never one named in the body. `body` is the request as it came: it has to be
 * an object whose keys are notification types and whose values are booleans.
 * The types it leaves out keep their choice, so the app saves one switch at a
 * time. Answers what the account has after the change.
 */
export async function updatePreferences(
  store: PreferenceStore,
  accountId: string,
  body: unknown,
  at: Date
): Promise<Preferences> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([
      { field: 'body', message: 'Tiene que ser un objeto con un booleano por tipo' },
    ]);
  }

  const changes: Partial<Preferences> = {};
  const errors: FieldError[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!isNotificationType(key)) {
      errors.push({ field: key, message: 'No es un tipo de notificación' });
    } else if (typeof value !== 'boolean') {
      errors.push({ field: key, message: 'Tiene que ser true o false' });
    } else {
      changes[key] = value;
    }
  }
  if (errors.length > 0) {
    throw validationFailed(errors);
  }

  await store.set(accountId, changes, at);
  return getPreferences(store, accountId);
}
