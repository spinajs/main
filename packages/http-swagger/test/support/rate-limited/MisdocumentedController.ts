import { BaseController, BasePath, Middleware, Ok, Post, RouteMiddleware } from '@spinajs/http';
import type { IRouteMiddlewareDoc } from '@spinajs/http';

// What a middleware configured from JS or JSON can hand over: no type keeps operation keys out.
const untypedExtensions: Record<string, unknown> = {
  'x-kept': true,
  deprecated: true,
  parameters: [{ name: 'injected', in: 'query', schema: { type: 'string' } }],
  requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
};

class OperationKeysDocMiddleware extends RouteMiddleware {
  public override documentation(): IRouteMiddlewareDoc {
    return { extensions: untypedExtensions };
  }
}

export class ThrowingDocMiddleware extends RouteMiddleware {
  public override documentation(): IRouteMiddlewareDoc {
    throw new Error('documentation exploded');
  }
}

class LockedDocMiddleware extends RouteMiddleware {
  public override documentation(): IRouteMiddlewareDoc {
    return { responses: { '423': { description: 'Locked' } } };
  }
}

/**
 * Middlewares whose documentation the builder must not trust.
 * @tags RateLimited
 */
@BasePath('misdocumented')
export class MisdocumentedController extends BaseController {
  @Post()
  @Middleware(OperationKeysDocMiddleware)
  public operationKeys() {
    return new Ok();
  }

  @Post()
  @Middleware(ThrowingDocMiddleware)
  @Middleware(LockedDocMiddleware)
  public throwing() {
    return new Ok();
  }
}
