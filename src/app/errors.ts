/** One rejected field of a request, so the client can mark that input. */
export interface FieldError {
  field: string;
  message: string;
}

/**
 * An error that becomes a Problem Details response.
 *
 * It lives here and not in `api/` because the services raise it, and they know
 * nothing about HTTP. Turning it into a response is `api/errors.ts`'s job. The
 * format is ARQUITECTURA.md's "Formato de error": RFC 9457.
 */
export class ProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly headers: Record<string, string>;
  /** Only on a validation failure: one entry per rejected field. */
  readonly errors: FieldError[] | undefined;

  constructor(options: {
    status: number;
    code: string;
    title: string;
    detail: string;
    headers?: Record<string, string>;
    errors?: FieldError[];
  }) {
    super(options.detail);
    this.name = 'ProblemError';
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.detail = options.detail;
    this.headers = options.headers ?? {};
    this.errors = options.errors;
  }
}
