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

/**
 * restore() hit a cap while resolutions kept starting during disposal. The container was still put back to the snapshot.
 */
export class RestoreIncomplete extends Error {
  constructor(
    message: string,
    public readonly InFlight: string[],
    public readonly DisposeErrors: Error[],
  ) {
    super(message);
  }
}
