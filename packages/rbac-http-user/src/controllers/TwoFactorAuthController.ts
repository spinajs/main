import { TokenDto } from './../dto/token-dto.js';
import { BaseController, BasePath, Cookie, Ok, Post, Unauthorized } from '@spinajs/http';
import { ISession, SessionProvider, User as UserModel, _user_ev, _user_update} from '@spinajs/rbac';
import { Session } from "@spinajs/rbac-http";
import { Body, Policy } from '@spinajs/http';
import _ from 'lodash';
import { User } from '../decorators.js';
import { TwoFacRouteEnabled } from '../policies/2FaPolicy.js';
import { AutoinjectService, _service } from '@spinajs/configuration';
import { TwoFactorAuthProvider } from '../interfaces.js';
import { DateTime } from 'luxon';
import { UserLoginSuccess } from '../events/UserLoginSuccess.js';
import { Autoinject } from '@spinajs/di';
import { QueueService } from '@spinajs/queue';
import { _chain, _check_arg, _non_empty, _non_null, _tap, _trim, _use } from '@spinajs/util';
import { User2FaPassed } from '../events/User2FaPassed.js';

export async function auth2Fa(user: User, token: string) {
  user = _check_arg(_non_null())(user, 'user');
  token = _check_arg(_trim(), _non_empty)(token, 'token');

  return _chain(
    _use(_service<TwoFactorAuthProvider>('rbac.twoFactorAuth'), 'twoFa'),
    _tap(async ({ twoFa }: { twoFa: TwoFactorAuthProvider }) => {
      await twoFa.verifyToken(token, user);
    }),
    _user_update({
      LastLoginAt: DateTime.now()
    }),
    _user_ev(User2FaPassed)
  );
}

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
  public async verifyToken(@User() logged: UserModel, @Body() token: TokenDto, @Session() session : ISession) {
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
