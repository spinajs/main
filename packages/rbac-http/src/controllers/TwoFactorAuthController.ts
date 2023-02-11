import { TokenDto } from './../dto/token-dto.js';
import { BaseController, BasePath, Cookie, Ok, Post, Unauthorized } from '@spinajs/http';
import { SessionProvider, User as UserModel } from '@spinajs/rbac';
import { Body, Policy } from '@spinajs/http';
import _ from 'lodash';
import { User } from '../decorators.js';
import { TwoFacRouteEnabled } from '../policies/2FaPolicy.js';
import { AutoinjectService } from '@spinajs/configuration';
import { TwoFactorAuthProvider } from '../interfaces.js';
import { DateTime } from 'luxon';
import { UserLoginSuccess } from '../events/UserLoginSuccess.js';
import { Autoinject } from '@spinajs/di';
import { QueueService } from '@spinajs/queue';

@BasePath('user/auth')
@Policy(TwoFacRouteEnabled)
export class TwoFactorAuthController extends BaseController {
  @Autoinject(QueueService)
  protected Queue: QueueService;

  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

  @AutoinjectService('rbac.twoFactorAuth')
  protected TwoFactorAuthProvider: TwoFactorAuthProvider;

  @Post('2fa/verify')
  public async verifyToken(@User() logged: UserModel, @Body() token: TokenDto, @Cookie() ssid: string) {
    const result = await this.TwoFactorAuthProvider.verifyToken(token.Token, logged);

    if (result) {
      return new Unauthorized(`invalid token`);
    }

    logged.LastLoginAt = DateTime.now();
    await logged.update();

    await this.Queue.emit(new UserLoginSuccess(logged.Uuid));

    await this.SessionProvider.save(ssid, {
      Authorized: true,
      TwoFactorAuth_check: true,
    });

    // return user data
    return new Ok(logged.dehydrate());
  }
}
