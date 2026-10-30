import { BaseController, BasePath, BufferResponse, ForbiddenResponse, Get, Ok, Query, Unauthorized } from '@spinajs/http';
import type { Response } from '@spinajs/http';

export class Greeting { public text: string }

async function guarded(fn: () => Promise<Response>): Promise<Response> {
  return fn();
}

@BasePath('responses')
export class ResponsesController extends BaseController {
  @Get('helper')
  public async helper(): Promise<Response> {
    return guarded(async () => new Ok(new Greeting()));
  }

  @Get('either')
  public async either(@Query() flag: boolean) {
    return flag ? new Unauthorized({ error: 'denied' }) : new Ok();
  }

  @Get('forbidden')
  public async forbidden(): Promise<ForbiddenResponse<Greeting>> {
    return new ForbiddenResponse(new Greeting());
  }

  @Get('buffer')
  public buffer(): BufferResponse {
    return new BufferResponse(Buffer.from('x'), 'application/octet-stream');
  }
}
