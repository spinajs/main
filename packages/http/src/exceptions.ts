import { Exception } from '@spinajs/exceptions';

export class EntityTooLargeException extends Exception {}

/**
 * Controller-level registration failure (unresolved instance, missing router).
 * Thrown during startup — fail fast, do not start with broken controllers.
 */
export class ControllerRegistrationException extends Exception {}

/**
 * Route-level registration failure (unknown route type, unresolvable policy,
 * missing route member). Thrown during startup — fail fast.
 */
export class RouteRegistrationException extends Exception {}

/** The client closed the connection before the route answered; `beforeRoute` says the rest of the chain never ran. */
export class RouteClientGone extends Exception {
  public readonly beforeRoute: boolean;

  constructor(options: { beforeRoute: boolean }, message?: string) {
    super(message ?? (options.beforeRoute ? 'The client went away before the route ran' : 'The client went away before the route answered'));
    this.beforeRoute = options.beforeRoute;
  }
}

/** The route does not take the request's content type, e.g. a raw-body route sent a body that a parser already read. */
export class UnsupportedMediaTypeException extends Exception {}

// Defined in @spinajs/exceptions so a package can throw it without depending on @spinajs/http.
export { CodedHttpException } from '@spinajs/exceptions';
export type { CodedErrorBody } from '@spinajs/exceptions';
