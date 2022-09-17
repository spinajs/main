import { TokenDto } from './../dto/token-dto';
import { BaseController, BasePath, Cookie, Ok, Post, Unauthorized } from '@spinajs/http';
import { SessionProvider, User as UserModel } from '@spinajs/rbac';
import { Body, Policy } from '@spinajs/http';
import _ from 'lodash';
import { User } from '../decorators';
import { TwoFacRouteEnabled } from '../policies/2FaPolicy';
import { AutoinjectService } from '@spinajs/configuration';
import { TwoFactorAuthProvider } from '../interfaces';
import { Autoinject } from '@spinajs/di';

@BasePath('user/auth')
@Policy(TwoFacRouteEnabled)
export class TwoFactorAuthController extends BaseController {
  @Autoinject()
  protected SessionProvider: SessionProvider;

  @AutoinjectService('rbac.twoFactorAuth.provider')
  protected TwoFactorAuthProvider: TwoFactorAuthProvider;

  @Post('2fa/verify')
  public async verifyToken(@User() logged: UserModel, @Body() token: TokenDto, @Cookie() ssid: string) {
    const result = await this.TwoFactorAuthProvider.verifyToken(token.Token, logged);

    if (result) {
      return new Unauthorized(`invalid token`);
    }

    const session = await this.SessionProvider.restore(ssid);
    session.Data.set('Authorized', true);
    session.Data.set('2fa_check', true);

    await this.SessionProvider.save(session);

    // return user data
    return new Ok(_.omit(logged.dehydrate(), ['Id']));
  }
}
