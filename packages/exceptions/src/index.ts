/**
 * Base class of all exceptions in framework
 */
export class Exception extends Error {
  /**
   * Constructs new exception with message
   *
   * @param message - error message
   * @param inner - inner exception ( eg. original couse of error )
   */
  public inner?: Error | unknown;

  constructor(message?: string, inner?: Error | unknown) {
    super(message);

    // Non-enumerable, so spreading the error (e.g. into an HTTP body) does not leak name or cause details.
    Object.defineProperty(this, 'name', { value: new.target.name, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(this, 'inner', { value: inner, enumerable: false, writable: true, configurable: true });
    if (inner !== undefined) {
      Object.defineProperty(this, 'cause', { value: inner, enumerable: false, writable: true, configurable: true });
    }
  }
}

/**
 * Exception thrown when connection to resource is not found
 */
export class ConnectionNotFound extends Exception {}

/**
 * Exception thrown when functionality is not supported
 */
export class NotSupported extends Exception {}

/**
 * Exception thrown when argument passed to function is invalid eg. out of range
 */
export class InvalidArgument extends Exception {
  constructor(message?: string, public fieldName?: string, public errorCode?: string, inner?: Error | unknown) {
    super(message, inner);
  }
}

/**
 * Exception thrown when config option is invalidl eg. missing or in invalid format
 */
export class InvalidOption extends Exception {}

/**
 * The exception that is thrown when a method call is invalid for the object's current state.
 */
export class InvalidOperation extends Exception {}

/**
 * Exception is thrown when authentication fails eg. user credentials are invalid
 */
export class AuthenticationFailed extends Exception {}

/**
 * Exception is thrown when request data are invalid
 */
export class BadRequest extends Exception {}

/**
 * Exception indicating that an access to resource by a client has been forbidden by the server
 * HTTP 403 - Forbidden
 */
export class Forbidden extends Exception {}

/**
 * Exception thrown when there was error with IO operations ie. not accessible file
 */
export class IOFail extends Exception {}

/**
 * The exception that is thrown when resource is not found eg. model in database or missing file
 */
export class ResourceNotFound extends Exception {}

/** The body `CodedHttpExceptionResponse` ( `@spinajs/http` ) answers a `CodedHttpException` with. */
export interface CodedErrorBody<TCode extends string = string, TDetails = unknown> {
  code: TCode;
  message: string;
  details?: TDetails;
}

/**
 * A refusal with its own HTTP status and a stable, machine-readable code. `CodedHttpExceptionResponse` ( `@spinajs/http` )
 * answers it with `{ code, message, details? }` and `status`, never with a stack.
 *
 * Narrow the code to the app's own union with a subclass: `class ApiException extends CodedHttpException<ApiErrorCode> {}`.
 */
export class CodedHttpException<TCode extends string = string, TDetails = unknown> extends Exception {
  // Own enumerable fields: the error handler hands the response `{ ...err, message }`, not the exception.
  public readonly status: number;
  public readonly code: TCode;
  public readonly details?: TDetails;

  /**
   * @param status - a 4xx or 5xx status
   * @param code - stable code the client branches on, e.g. `invoice.locked`
   * @param message - text for people; defaults to the code
   * @param details - extra data the client acts on, sent as `details`; must survive `JSON.stringify`
   * @param inner - the cause; kept off the response body
   */
  constructor(status: number, code: TCode, message?: string, details?: TDetails, inner?: unknown) {
    super(message ?? code, inner);

    if (!Number.isInteger(status) || status < 400 || status > 599) {
      // Not InvalidArgument: the error map answers that 400, and a bad status is the server's bug.
      throw new UnexpectedServerError(`CodedHttpException status must be an integer from 400 to 599, got ${status}`);
    }

    this.status = status;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/**
 * The exception that is thrown when method is not implemented
 */
export class MethodNotImplemented extends Exception {}

/**
 * The exception that is thrown when strange things happends in server eg. generic server error
 */
export class UnexpectedServerError extends Exception {}

/**
 * Exception occurs when resource is duplicated eg. unique constraint failed in db
 */
export class ResourceDuplicated extends Exception {}

/**
 * The exception that is thrown when JSON entity is checked against schema and is invalid
 */
export class JsonValidationFailed extends Exception {}

/**
 * The exception that is thrown if app not supports requestes `Accept` header eg. if client wants
 * html response but server can send only json.
 */
export class ExpectedResponseUnacceptable extends Exception {}

/** A stream or input went over a configured size limit. */
export class LimitExceeded extends Exception {}

export * from './describe.js';
