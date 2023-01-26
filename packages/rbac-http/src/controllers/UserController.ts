import { PasswordDto } from '../dto/password-dto.js';
import { User as UserModel, PasswordProvider, SessionProvider } from '@spinajs/rbac';
import { BaseController, BasePath, Get, Ok, Body, Patch, Cookie } from '@spinajs/http';
import { InvalidArgument, Forbidden } from '../@spinajs/exceptions';
import { Autoinject } from '@spinajs/di';
import { Permission, User, Resource } from '../decorators.js';
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
    await user.Metadata.populate();

    // refresh session data from DB
    const sId: string | false = cs.unsign(ssid, this.CoockieSecret);
    if (sId) {
      const session = await this.SessionProvider.restore(sId);
      if (session) {
        session.Data.set('User', user.dehydrate());
      }
    }

    return new Ok(user.dehydrate());
  }

  @Patch('/password')
  public async newPassword(@User() user: UserModel, @Body() pwd: PasswordDto) {
    if (pwd.Password !== pwd.ConfirmPassword) {
      throw new InvalidArgument('password does not match');
    }

    const isValid = await this.PasswordProvider.verify(user.Password, pwd.OldPassword);

    if (!isValid) {
      throw new Forbidden('old password do not match');
    }

    const hashedPassword = await this.PasswordProvider.hash(pwd.Password);
    user.Password = hashedPassword;
    await user.update();
    return new Ok();
  }
}
