import { ProblemError } from './errors';

/**
 * The FCM token of a device: the address a push is sent to. The app hands it
 * over after every login (E4-H1 CA.3), and the push of a new follower is sent
 * to every token of the followed account.
 */
export interface DeviceTokenStore {
  /**
   * Records that the token belongs to the account, as of `at`.
   *
   * A token identifies one installation of the app, so it belongs to whoever
   * signed in on that device last: registering it again under another account
   * moves it, and under the same one only refreshes `at`. A token deleted with
   * its account comes back under whoever signs in on that device next.
   * Repeating the call changes nothing else.
   */
  register(token: string, accountId: string, at: Date): Promise<void>;
  /**
   * Marks every token of the account deleted at `at`, for when the account is
   * deleted. Tokens already deleted keep their date.
   */
  softDeleteOwnedBy(accountId: string, at: Date): Promise<void>;
}

/**
 * Generous on purpose: an FCM token runs about 160 characters today and Google
 * promises no size. The cap only keeps a client from storing whatever it likes.
 */
export const MAX_TOKEN_LENGTH = 4096;

/**
 * Registers the device the app signed in on (E4-H1 CA.3). The account is the
 * caller's, never one named in the body. `body` is the request as it came: a
 * body that is not an object, or has no usable `token`, is rejected the same.
 */
export async function registerDeviceToken(
  store: DeviceTokenStore,
  accountId: string,
  body: unknown,
  at: Date
): Promise<void> {
  const token = (body as { token?: unknown } | null | undefined)?.token;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new ProblemError({
      status: 422,
      code: 'validation-failed',
      title: 'La solicitud tiene campos inválidos',
      detail: 'Revisá los campos indicados y volvé a intentar',
      errors: [
        { field: 'token', message: `Tiene que ser un texto de 1 a ${MAX_TOKEN_LENGTH} caracteres` },
      ],
    });
  }
  await store.register(token, accountId, at);
}
