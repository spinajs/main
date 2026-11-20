import { BaseController, BasePath, Idempotent, IdempotencyMiddleware, Middleware, Ok, Post, RouteMiddleware } from '@spinajs/http';

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

  @Post()
  @Middleware(IdempotencyMiddleware, { ttl: '5m' })
  @Middleware(First)
  @Idempotent({ ttl: '1h' })
  public handAbove(): Ok {
    return new Ok();
  }

  @Post()
  @Middleware(IdempotencyMiddleware, { ttl: '5m' })
  @Middleware(IdempotencyMiddleware, { ttl: '10m' })
  public twoHand(): Ok {
    return new Ok();
  }
}

@BasePath('hand-class')
@Middleware(IdempotencyMiddleware, { ttl: '5m' })
@Middleware(IdempotencyMiddleware, { ttl: '10m' })
export class HandGatedController extends BaseController {
  @Post()
  public save(): Ok {
    return new Ok();
  }
}

@BasePath('idem-base')
export class IdemBaseController extends BaseController {
  @Post()
  @Idempotent({ ttl: '24h' })
  public save(): Ok {
    return new Ok();
  }
}

@BasePath('idem-sub')
export class IdemSubController extends IdemBaseController {
  @Post()
  @Middleware(IdempotencyMiddleware, { ttl: '5m' })
  @Idempotent({ ttl: '1h' })
  public save(): Ok {
    return new Ok();
  }
}
