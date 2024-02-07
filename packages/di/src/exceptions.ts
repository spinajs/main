/**
 * Exception thrown when cannot resolve type
 */
export class ResolveException extends Error {
  /**
   * Constructs new exception with message
   * @param message - error message
   */
  constructor(message?: string, public InnerError? : Error) {
    super(message);
  }
}

export class BindException extends Error {}

/**
 * Service is not registered in DI container
 */
export class ServiceNotFound extends Error {}
