import type { IRoute, IRouteParameter } from './interfaces.js';

/**
 * Filters a non-primitive route argument before it is validated and hydrated. Every registered
 * filter runs, in registration order, on the output of the previous one. Socket handlers call it
 * for the payload, without a route.
 */
export abstract class ArgInputFilter {
  /** Returns the input to validate and hydrate. May throw (e.g. a 400 or 403 error) to reject it. */
  public abstract filter(input: unknown, parameter: IRouteParameter, route?: IRoute): unknown | Promise<unknown>;
}
