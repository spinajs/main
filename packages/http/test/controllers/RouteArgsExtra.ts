import { BaseController, BasePath, Get, Post, Ok, Ip, RequestId, UserAgent, Referer, RawBody, FromXml } from '../../src/index.js';

@BasePath('extra')
export class RouteArgsExtra extends BaseController {
  @Get('ip')
  public ip(@Ip() ip: string) {
    return new Ok({ ip });
  }

  @Get('rid')
  public rid(@RequestId() rid: string) {
    return new Ok({ rid });
  }

  @Get('ua')
  public ua(@UserAgent() ua: string) {
    return new Ok({ ua });
  }

  @Get('ref')
  public ref(@Referer() ref: string) {
    return new Ok({ ref });
  }

  @Post('raw')
  public raw(@RawBody() raw: Buffer) {
    return new Ok({ len: raw ? raw.length : null, isBuffer: Buffer.isBuffer(raw) });
  }

  @Post('xml')
  public xml(@FromXml() doc: any) {
    return new Ok(doc);
  }
}
