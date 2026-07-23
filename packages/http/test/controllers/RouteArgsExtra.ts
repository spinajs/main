import { BaseController, BasePath, Get, Post, Ok, Ip, RequestId, UserAgent, Referer, RawBody, FromXml, Query, Body, Form, Type, HTTP_STATUS_CODE, Xml, Redirect } from '../../src/index.js';

class SampleItem {
  public id: number;
  constructor(data: any) {
    Object.assign(this, data);
  }
}

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

  @Get('required')
  public required(@Query({ type: 'string' }, { required: true }) term: string) {
    return new Ok({ term });
  }

  @Post('form')
  public form(@Form() data: any) {
    return new Ok(data);
  }

  @Post('typedarr')
  public typedarr(@Body() @Type(Array.ofType(SampleItem)) items: SampleItem[]) {
    return new Ok({ count: items.length });
  }

  @Get('zero')
  public zero() {
    return new Ok(0);
  }

  @Get('bool')
  public bool() {
    return new Ok(false);
  }

  @Get('status')
  public status() {
    return new Ok({ ok: true }, { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
  }

  @Get('xmlout')
  public xmlout() {
    return new Xml({ user: { id: 7 } });
  }

  @Get('goredirect')
  public goredirect() {
    return new Redirect('/extra/ip', HTTP_STATUS_CODE.MOVED_PERMANENTLY);
  }
}
