import { NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Middleware } from '../decorators.js';
import { UnsupportedMediaTypeException } from '../exceptions.js';
import { RouteMiddleware } from '../interfaces.js';
import type { IController, IMiddlewareContext, IRoute } from '../interfaces.js';
import { overriddenByRoute } from './route-declaration.js';

/**
 * Refuses a request whose body is of none of the given media types with `UnsupportedMediaTypeException`, answered as
 * `UnsupportedMediaType` (415). A request without a body passes. Mounted by {@link Consumes}; a route's own declaration
 * replaces the controller's.
 */
@NewInstance()
export class ConsumesMiddleware extends RouteMiddleware {
  constructor(public readonly types: readonly string[]) {
    super();
  }

  public override isEnabled(route: IRoute, _controller: IController): boolean {
    return !overriddenByRoute(route, ConsumesMiddleware, this.types);
  }

  public onBefore({ req }: IMiddlewareContext): void {
    // req.is() counts `Content-Length: 0` as a body
    if (req.headers['content-length'] === '0' && req.headers['transfer-encoding'] === undefined) {
      return;
    }
    // null: no body; false: a body of another type, or one without Content-Type
    if (req.is(this.types as string[]) === false) {
      throw new UnsupportedMediaTypeException(`the request body must be ${this.types.join(' or ')}`);
    }
  }
}

/**
 * Answers 415 Unsupported Media Type when the request has a body whose `Content-Type` matches none of `types`: full
 * types (`application/json`), wildcards (`text/*`) or extensions (`json`), as `req.is()` takes them.
 */
export function Consumes(...types: string[]) {
  if (types.length === 0 || types.some((t) => typeof t !== 'string' || t.trim() === '')) {
    throw new InvalidArgument('@Consumes needs at least one media type');
  }
  return Middleware(ConsumesMiddleware, types);
}
