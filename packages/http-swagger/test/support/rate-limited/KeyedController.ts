import { BaseController, BasePath, Middleware, Ok, Post, RouteMiddleware } from '@spinajs/http';
import type { IRouteMiddlewareDoc } from '@spinajs/http';

class KeyedDocMiddleware extends RouteMiddleware {
  public override documentation(): IRouteMiddlewareDoc {
    return { requestHeaders: { 'X-Key': { description: 'A key', required: true, schema: { type: 'string', maxLength: 8 } } } };
  }
}

/**
 * A route whose middleware reads a request header.
 * @tags RateLimited
 */
@BasePath('keyed')
export class KeyedController extends BaseController {
  @Post()
  @Middleware(KeyedDocMiddleware)
  public create() {
    return new Ok();
  }
}
