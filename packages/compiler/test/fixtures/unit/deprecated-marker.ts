import { BaseController, BasePath, Deprecated as Sunsetting, Get, Ok } from '@spinajs/http';

@BasePath('legacy')
@Sunsetting({ since: new Date('2026-01-01'), sunset: new Date('2026-12-31') })
export class LegacyController extends BaseController {
  @Get('list')
  public list(): Ok {
    return new Ok();
  }
}

@BasePath('partly')
export class PartlyController extends BaseController {
  @Get('old')
  @Sunsetting({ since: new Date('2026-01-01') })
  public old(): Ok {
    return new Ok();
  }

  /** Still served. */
  @Get('current')
  public current(): Ok {
    return new Ok();
  }
}

declare function Deprecated(): MethodDecorator;

@BasePath('lookalike')
export class LookalikeController extends BaseController {
  @Get('x')
  @Deprecated()
  public x(): Ok {
    return new Ok();
  }
}
