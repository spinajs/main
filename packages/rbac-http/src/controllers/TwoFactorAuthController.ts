import { TokenDto } from './../dto/token-dto';
import { BaseController, BasePath, Cookie, Ok, Post, Unauthorized } from '@spinajs/http';
import { SessionProvider, User as UserModel } from '@spinajs/rbac';
import { Body, Policy } from '@spinajs/http';
import _ from 'lodash';
import { User } from '../decorators';
import { TwoFacRouteEnabled } from '../policies/2FaPolicy';
import { Config } from '@spinajs/configuration';
import { TwoFactorAuthConfig, TwoFactorAuthProvider } from '../interfaces';
import { Autoinject, DI, ServiceNotFound } from '@spinajs/di';

@BasePath('user/auth')
@Policy(TwoFacRouteEnabled)
export class TwoFactorAuthController extends BaseController {
  @Config('rbac.twoFactorAuth')
  protected TwoFactorConfig: TwoFactorAuthConfig;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  protected TwoFactorAuthProvider: TwoFactorAuthProvider;

  public async resolveAsync(): Promise<void> {
    if (this.TwoFactorConfig.enabled) {
      if (!DI.check(this.TwoFactorConfig.service)) {
        throw new ServiceNotFound(`2FA provider ${this.TwoFactorConfig.service} not registered in DI container`);
      }
      this.TwoFactorAuthProvider = DI.resolve(this.TwoFactorConfig.service);
    }
  }

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
