import { Route, Parameter, BaseController, BasePath, Get, Param } from '@spinajs/http';

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
}
