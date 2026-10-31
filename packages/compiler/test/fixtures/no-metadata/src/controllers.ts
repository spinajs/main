import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { Route, Parameter, BaseController, BasePath, Get, Param, Query, Req, RequestStream } from '@spinajs/http';
import type { DateTime } from 'luxon';

export class Principal {}

const CurrentUser = () => Route(Parameter('CurrentUserArg'));

export abstract class CrudController extends BaseController {
  @Get(':id')
  public get(@Param() id: number) {
    return id;
  }
}

@BasePath('users')
export class UsersController extends CrudController {
  @Get('me')
  public me(@Param() id: number, @CurrentUser() user: Principal, plain: string) {
    return [id, user, plain];
  }

  @Get()
  public upload(@RequestStream() body: Readable, @Req() req: IncomingMessage) {
    return [body, req];
  }

  @Get()
  public since(@Query() when: DateTime) {
    return when;
  }
}
