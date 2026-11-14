import { BaseController, BasePath, Middleware, Ok, Post, RouteMiddleware } from '@spinajs/http';
import type { IRouteMiddlewareDoc } from '@spinajs/http';

import { access } from '../fake-access.js';

class OverlappingDocMiddleware extends RouteMiddleware {
  public override documentation(): IRouteMiddlewareDoc {
    return {
      responses: { '403': { description: 'Blocked by the middleware' }, '423': { description: 'Locked' } },
      extensions: { 'x-authz-domain': 'middleware', 'x-guarded': true },
    };
  }
}

/**
 * A guarded route whose middleware documents a status and an extension `@Access` already set.
 * @tags RateLimited
 */
@BasePath('guarded')
export class GuardedController extends BaseController {
  @Post()
  @access('test:update', { domain: 'tenant' })
  @Middleware(OverlappingDocMiddleware)
  public overlapping() {
    return new Ok();
  }
}
