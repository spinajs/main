import { BaseController, BasePath, Body, Get, Ok, Post } from '@spinajs/http';
import type { ModelData } from '@spinajs/orm';
import type { User } from '@spinajs/users';

export interface IUserView extends User {
  Shown: boolean;
}

/** The real `User` of `@spinajs/users`, read from its declaration files, reached through derived types. */
@BasePath('users')
export class UsersViewController extends BaseController {
  @Get('partial')
  public async partial(): Promise<Ok<Partial<User>>> {
    return new Ok({});
  }
  @Get('pick')
  public async pick(): Promise<Ok<Pick<User, 'Login' | 'Password'>>> {
    return new Ok({ Login: '', Password: '' });
  }
  @Get('omit')
  public async omit(): Promise<Ok<Omit<User, 'Password'>[]>> {
    return new Ok([]);
  }
  @Get('data')
  public async data(): Promise<Ok<Partial<ModelData<User>>>> {
    return new Ok({});
  }
  @Get('view')
  public async view(): Promise<Ok<IUserView>> {
    return new Ok(undefined as unknown as IUserView);
  }
  @Post()
  public async update(@Body() body: Readonly<Required<User>>): Promise<Ok<Required<User>>> {
    return new Ok(body as Required<User>);
  }
}
