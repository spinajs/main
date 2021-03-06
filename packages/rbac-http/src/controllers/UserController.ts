import { PasswordDto } from '../dto/password-dto';
import { User as UserModel, PasswordProvider, SessionProvider } from '@spinajs/rbac';
import { BaseController, BasePath, Get, Ok, Body, Param, Patch, Cookie } from '@spinajs/http';
import { InvalidArgument, Forbidden } from '@spinajs/exceptions';
import { Autoinject } from '@spinajs/di';
import { Permission, User, Resource } from '../decorators';
import { Config } from '@spinajs/configuration';
import * as cs from 'cookie-signature';
import _ from 'lodash';

@BasePath('user')
@Resource('user')
export class UserController extends BaseController {
  @Autoinject()
  protected PasswordProvider: PasswordProvider;

  @Config('http.cookie.secret')
  protected CoockieSecret: string;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  @Get()
  @Permission('readOwn')
  public async refresh(@User() user: UserModel, @Cookie() ssid: string) {
    // get user data from db
    await user.refresh();

    // refresh session data from DB
    const sId: string | false = cs.unsign(ssid, this.CoockieSecret);
    if (sId) {
      const session = await this.SessionProvider.restore(sId);
      if (session) {
        session.Data.set('User', user.dehydrate());
      }
    }

    return new Ok(_.omit(user.dehydrate(), ['Id']));
  }

  @Patch('/password/:login')
  public async newPassword(@Param() login: string, @Body() pwd: PasswordDto) {
    if (pwd.Password !== pwd.ConfirmPassword) {
      throw new InvalidArgument('password does not match');
    }

    const user = await UserModel.where({ Login: login }).firstOrFail();
    const isValid = await this.PasswordProvider.verify(user.Password, pwd.OldPassword);

    if (!isValid) {
      throw new Forbidden('Invalid login or password');
    }

    const hashedPassword = await this.PasswordProvider.hash(pwd.Password);
    user.Password = hashedPassword;
    await user.update();
    return new Ok();
  }
}
