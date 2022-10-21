import { InvalidOperation } from '@spinajs/exceptions';
import { UserLoginDto } from '../dto/userLogin-dto';
import { BaseController, BasePath, Post, Body, Ok, Get, Cookie, CookieResponse, Unauthorized, NotAllowed, Header } from '@spinajs/http';
import { AuthProvider, FederatedAuthProvider, Session, SessionProvider, User as UserModel } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService, Config, Configuration } from '@spinajs/configuration';
import { User } from './../decorators';
import _ from 'lodash';
import { FingerprintProvider, TwoFactorAuthProvider } from '../interfaces';

@BasePath('user/auth')
export class LoginController extends BaseController {
  @Autoinject()
  protected Configuration: Configuration;

  @AutoinjectService('rbac.auth.provider')
  protected AuthProvider: AuthProvider;

  @AutoinjectService('rbac.session.provider')
  protected SessionProvider: SessionProvider;

  @Config('rbac.session.expiration', 120)
  protected SessionExpirationTime: number;

  @AutoinjectService('rbac.twoFactorAuth.provider')
  protected TwoFactorAuthProvider: TwoFactorAuthProvider;

  @AutoinjectService('rbac.fingerprint.provider')
  protected FingerprintPrivider: FingerprintProvider;

  @Autoinject(FederatedAuthProvider)
  protected FederatedLoginStrategies: FederatedAuthProvider<any>[];

  @Post('federated-login')
  public async loginFederated(@Body() credentials: unknown, @Header('Host') caller: string, @User() logged: UserModel) {
    if (logged) {
      return new NotAllowed('User already logged in. Please logout before trying to authorize.');
    }

    const strategy = this.FederatedLoginStrategies.find((x) => x.callerCheck(caller));
    if (!strategy) {
      throw new InvalidOperation(`No auth stragegy registered for caller ${caller}`);
    }

    const user = await strategy.authenticate(credentials);

    // proceed with standard authentication
    return await this.authenticate(user);
  }

  /**
   *
   * Api call for listing avaible federated login strategies
   *
   * @returns response with avaible login strategies
   */
  @Get()
  public async federatedLogin() {
    return new Ok(this.FederatedLoginStrategies.map((x) => x.Name));
  }

  @Post()
  public async login(@Body() credentials: UserLoginDto, @User() logged: UserModel) {
    if (logged) {
      return new NotAllowed('User already logged in. Please logout before trying to authorize.');
    }

    const user = await this.AuthProvider.authenticate(credentials.Email, credentials.Password);
    return await this.authenticate(user);
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

  protected async authenticate(user: UserModel, federated?: boolean) {
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

    // if its federated login, skip 2fa - assume
    // external login service provided it
    if (this.TwoFactorConfig.enabled || !federated) {
      await this.SessionProvider.save(session);

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
              twoFactorAuthFirstTime: true,
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
    return new CookieResponse('ssid', session.SessionId, this.SessionExpirationTime, true, dUser, { httpOnly: true });
  }
}
