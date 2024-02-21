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
  constructor(message?: string, public inner?: Error | unknown) {
    super(message);
  }
}

/**
 * Exception with error code
 */
export class ErrorCode extends Exception {
  constructor(public code: number, message?: string, public data? : unknown) {
    super(message);
  }
}

/**
 * Exception thrown when functionality is not supported
 */
export class NotSupported extends Exception {}

/**
 * Exception thrown when argument passed to function is invalid eg. out of range
 */
export class InvalidArgument extends Exception {}

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
