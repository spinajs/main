import { PasswordDto } from '../dto/password-dto.js';
import { User as UserModel, PasswordProvider, SessionProvider, passwordMatch, changePassword, _unwindGrants, AccessControl } from '@spinajs/rbac';
import { BaseController, BasePath, Get, Ok, Body, Patch, Cookie, Policy } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Autoinject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import * as cs from 'cookie-signature';
import _ from 'lodash';
import { AuthorizedPolicy, Permission, Resource, User } from '@spinajs/rbac-http';
import { _chain, _either } from '@spinajs/util';



@BasePath('user')
@Resource('user')
@Policy(AuthorizedPolicy)
export class UserController extends BaseController {
  @Autoinject()
  protected PasswordProvider: PasswordProvider;

  @Config('http.cookie.secret')
  protected CoockieSecret: string;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  @Autoinject(AccessControl)
  protected AC: AccessControl;

  @Get()
  @Permission(['readOwn'])
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

  @Get("grants")
  @Permission(['readOwn'])
  public async getGrants(@User() user: UserModel) {

    const grants = this.AC.getGrants();
    const userGrants = user.Role.map(r => _unwindGrants(r, grants));
    const combinedGrants = Object.assign({}, ...userGrants);

    return new Ok(combinedGrants);
  }


  @Patch('password')
  @Permission(["updateOwn"])
  public async newPassword(@User() user: UserModel, @Body() pwd: PasswordDto) {
    if (pwd.Password !== pwd.ConfirmPassword) {
      throw new InvalidArgument('password does not match');
    }


    return new Ok(
      _chain(
        user,
        _either(
          passwordMatch(pwd.OldPassword),
          changePassword(pwd.Password),
          () => {
            throw new InvalidArgument('Old password is incorrect');
          }),
      ),
    );
  }
}
