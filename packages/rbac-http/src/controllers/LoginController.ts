import { UserLoginDto } from '../dto/userLogin-dto';
import { BaseController, BasePath, Post, Body, Ok, Get, Cookie, CookieResponse, Unauthorized, NotAllowed } from '@spinajs/http';
import { AuthProvider, Session, SessionProvider, User as UserModel } from '@spinajs/rbac';
import { Autoinject, DI, ServiceNotFound } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { User } from './../decorators';
import _ from 'lodash';
import { FingerpringConfig, FingerprintPrivider, TwoFactorAuthConfig, TwoFactorAuthProvider } from '../interfaces';

@BasePath('user/auth')
export class LoginController extends BaseController {
  @Autoinject()
  protected Configuration: Configuration;

  @Autoinject()
  protected AuthProvider: AuthProvider;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  @Config('rbac.session.expiration', 120)
  protected SessionExpirationTime: number;

  @Config('rbac.twoFactorAuth')
  protected TwoFactorConfig: TwoFactorAuthConfig;

  @Config('rbac.fingerprint')
  protected FingerPrintConfig: FingerpringConfig;

  protected TwoFactorAuthProvider: TwoFactorAuthProvider;

  protected FingerprintPrivider: FingerprintPrivider;

  public async resolveAsync(): Promise<void> {
    if (this.TwoFactorConfig.enabled) {
      if (!DI.check(this.TwoFactorConfig.service)) {
        throw new ServiceNotFound(`2FA provider ${this.TwoFactorConfig.service} not registered in DI container`);
      }
      this.TwoFactorAuthProvider = DI.resolve(this.TwoFactorConfig.service);
    }

    if (this.FingerPrintConfig.enabled) {
      if (!DI.check(this.FingerPrintConfig.service)) {
        throw new ServiceNotFound(`Fingerprint provider ${this.FingerPrintConfig.service} not registered in DI container`);
      }
      this.FingerprintPrivider = DI.resolve(this.FingerPrintConfig.service);
    }
  }

  @Post()
  public async login(@Body() credentials: UserLoginDto, @User() logged: UserModel) {
    if (logged) {
      return new NotAllowed('User already logged in. Please logout before trying to authorize.');
    }

    const user = await this.AuthProvider.authenticate(credentials.Email, credentials.Password);

    if (!user) {
      return new Unauthorized({
        error: {
          message: 'login or password incorrect',
        },
      });
    }

    await user.Metadata.populate();

    const session = new Session();
    const dUser = user.dehydrate();
    session.Data.set('User', dUser);

    // we found user but we still dont know if is authorized
    // eg. 2fa auth is not performed
    // create session, but user is not yet authorized
    session.Data.set('Authorized', false);

    await this.SessionProvider.save(session);

    if (this.TwoFactorConfig.enabled) {
      const enabledForUser = await this.TwoFactorAuthProvider.isEnabled(user);

      /**
       * if 2fa is enabled for user, proceed
       */
      if (enabledForUser) {
        /**
         * check if 2fa system is initialized for user eg. private key is generated.
         */
        const isInitialized = await this.TwoFactorAuthProvider.isInitialized(user);
        if (!isInitialized) {
          const twoFaResult = await this.TwoFactorAuthProvider.initialize(user);

          return new CookieResponse(
            'ssid',
            session.SessionId,
            this.SessionExpirationTime,
            true,
            {
              toFactorAuth: true,
              initialize: true,
              method: this.TwoFactorConfig.service,
              data: twoFaResult,
            },
            { httpOnly: true },
          );
        }

        // give chance to execute 2fa eg. send sms or email
        await this.TwoFactorAuthProvider.execute(user);

        // return session to identify user
        // and only info that twoFactor auth is requested
        return new CookieResponse(
          'ssid',
          session.SessionId,
          this.SessionExpirationTime,
          true,
          {
            toFactorAuth: true,
          },
          { httpOnly: true },
        );
      }
    }

    // 2fa is not enabled, so we found user, it means it is logged
    session.Data.set('Authorized', true);
    await this.SessionProvider.save(session);

    // BEWARE: httpOnly coockie, only accesible via http method in browser
    // return coockie session id with additional user data
    return new CookieResponse('ssid', session.SessionId, this.SessionExpirationTime, true, _.omit(dUser, ['Id']), { httpOnly: true });
  }

  @Get()
  public async logout(@Cookie() ssid: string) {
    if (!ssid) {
      return new Ok();
    }

    await this.SessionProvider.delete(ssid);

    // send empty cookie to confirm session deletion
    return new CookieResponse('ssid', null, this.SessionExpirationTime);
  }
}
