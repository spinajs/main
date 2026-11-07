import { Accepts, Accepts as Acceptable, BaseController, BasePath, BotCheck, Get, HttpAcceptHeaders, Idempotent, Middleware, Post, RouteMiddleware } from '@spinajs/http';
import { Unscoped } from '@spinajs/authz-http';

declare function Deprecated(options?: object): MethodDecorator;

class Audit extends RouteMiddleware {
  public isEnabled(): boolean {
    return true;
  }
}

@BotCheck('signup')
export abstract class GuardedBase extends BaseController {}

@BasePath('factories')
@BotCheck('signup')
export class FactoriesController extends BaseController {
  @Get('accepts')
  @Middleware(Audit, 1)
  @Accepts(HttpAcceptHeaders.JSON)
  public accepts(): void {}

  @Post('idempotent')
  @Idempotent({ ttl: '1h' })
  public idempotent(): void {}

  @Get('unscoped')
  @Unscoped('reports span every tenant')
  public unscoped(): void {}

  @Get('aliased')
  @Acceptable(HttpAcceptHeaders.HTML)
  public aliased(): void {}

  @Get('lookalike')
  @Deprecated({ link: 'https://example.com' })
  public lookalike(): void {}
}
