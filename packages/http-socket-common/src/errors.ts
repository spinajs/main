export type ErrorCode =
  | 'invalid_argument'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'failed_precondition'
  | 'unimplemented'
  | 'deadline_exceeded'
  | 'cancelled'
  | 'resource_exhausted'
  | 'unavailable'
  | 'version_mismatch'
  | 'internal';

export const ERROR_CODES: readonly ErrorCode[] = [
  'invalid_argument',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'failed_precondition',
  'unimplemented',
  'deadline_exceeded',
  'cancelled',
  'resource_exhausted',
  'unavailable',
  'version_mismatch',
  'internal',
];

/**
 * Retryability a code has unless the thrower says otherwise. A size-limit refusal is the one
 * `resource_exhausted` that is sent as not retryable: resending the same payload cannot succeed.
 */
export const DEFAULT_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  invalid_argument: false,
  unauthenticated: false,
  forbidden: false,
  not_found: false,
  conflict: false,
  failed_precondition: false,
  unimplemented: false,
  deadline_exceeded: true,
  cancelled: false,
  resource_exhausted: true,
  unavailable: true,
  version_mismatch: false,
  internal: false,
};

export interface SocketError {
  code: ErrorCode;
  message: string;
  /** Validation errors, conflicting keys, limits … */
  details?: unknown;
  retryable: boolean;
  retryAfterMs?: number;
  /** Matches the server log line of an `internal` error. */
  errorId?: string;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function isSocketError(value: unknown): value is SocketError {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const v = value as Record<string, unknown>;
  return isErrorCode(v.code) && typeof v.message === 'string' && typeof v.retryable === 'boolean';
}

export interface SocketExceptionOptions {
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
  errorId?: string;
  cause?: unknown;
}

/**
 * A throwable `SocketError`. Server handlers throw it to answer with a specific code; the client
 * rejects command promises with it.
 */
export class SocketException extends Error implements SocketError {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly details?: unknown;
  public readonly retryAfterMs?: number;
  public readonly errorId?: string;

  constructor(code: ErrorCode, message: string, options: SocketExceptionOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SocketException';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];

    if (options.details !== undefined) {
      this.details = options.details;
    }

    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }

    if (options.errorId !== undefined) {
      this.errorId = options.errorId;
    }
  }

  public toWire(): SocketError {
    const wire: SocketError = { code: this.code, message: this.message, retryable: this.retryable };

    if (this.details !== undefined) {
      wire.details = this.details;
    }

    if (this.retryAfterMs !== undefined) {
      wire.retryAfterMs = this.retryAfterMs;
    }

    if (this.errorId !== undefined) {
      wire.errorId = this.errorId;
    }

    return wire;
  }

  public static fromWire(error: SocketError): SocketException {
    return new SocketException(error.code, error.message, {
      details: error.details,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      errorId: error.errorId,
    });
  }
}
