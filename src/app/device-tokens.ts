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
