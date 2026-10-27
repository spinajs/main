import type { Response as ExpressResponse } from 'express';
import { BaseController, BasePath, FromDI, Get, Ok, Param, Req, Res } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Configuration } from '@spinajs/configuration';

export class Greeting { public text: string }

@BasePath('injected')
export class InjectedController extends BaseController {
  @Get(':id')
  public async read(@Req() req: Request, @Res() res: ExpressResponse, @FromDI() config: Configuration, @Param() id: string): Promise<Ok<Greeting>> {
    void req; void res; void config;
    return new Ok({ text: id });
  }
}
