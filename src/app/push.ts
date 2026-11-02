/** One push, the same for every device of the account it goes to. */
export interface PushMessage {
  title: string;
  body: string;
  /**
   * What the app reads when the push is tapped, to know where to open. FCM
   * only carries strings here.
   */
  data: Record<string, string>;
}

export interface PushResult {
  /** The tokens the provider said no longer exist: nothing sent to them will ever arrive. */
  invalidTokens: string[];
}

/**
 * Delivers one push to a set of device tokens. A token that fails does not
 * reject the call: the provider's verdict on each one comes back in the result.
 * Rejects only when the provider could not be asked at all.
 */
export interface PushSender {
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
}
