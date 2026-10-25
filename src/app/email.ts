export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text body. It carries secrets (links, codes): never log it. */
  text: string;
}

/**
 * Delivers one email. Rejects when the provider did not accept it; the message
 * of the error must not carry the body.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
