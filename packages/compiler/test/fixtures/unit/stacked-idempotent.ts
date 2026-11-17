import { BaseController, BasePath, Idempotent, Middleware, Ok, Post, RouteMiddleware } from '@spinajs/http';

class First extends RouteMiddleware {}
class Second extends RouteMiddleware {}

@BasePath('stacked')
export class StackedIdemController extends BaseController {
  @Post()
  @Middleware(First)
  @Idempotent({ ttl: '2h' })
  @Middleware(Second)
  @Idempotent({ ttl: '1h' })
  public mixed(): Ok {
    return new Ok();
  }
}
