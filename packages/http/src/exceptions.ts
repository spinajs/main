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

/** The route does not take the request's content type, e.g. a raw-body route sent a body that a parser already read. */
export class UnsupportedMediaTypeException extends Exception {}
