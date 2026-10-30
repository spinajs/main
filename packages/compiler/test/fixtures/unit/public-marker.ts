import { BaseController, BasePath, Get, Ok, Public as Open } from '@spinajs/http';

@BasePath('probe')
@Open('infrastructure probes')
export class ProbeController extends BaseController {
  @Get('live')
  public live(): Ok {
    return new Ok();
  }
}

@BasePath('mixed')
export class MixedController extends BaseController {
  @Get('login')
  @Open('credentials are the guard')
  public login(): Ok {
    return new Ok();
  }

  @Get('other')
  public other(): Ok {
    return new Ok();
  }
}
