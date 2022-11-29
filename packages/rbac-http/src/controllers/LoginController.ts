import { InsertBehaviour } from './../../../orm/src/interfaces';
import { BadRequest } from './../../../http/src/response-methods/badRequest';
import { InvalidOperation } from '@spinajs/exceptions';
import { UserLoginDto } from '../dto/userLogin-dto';
import { BaseController, BasePath, Post, Body, Ok, Get, Cookie, CookieResponse, Unauthorized, Header, Policy, Query } from '@spinajs/http';
import { AuthProvider, FederatedAuthProvider, Session, SessionProvider, User as UserModel, UserMetadata } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService, Config, Configuration } from '@spinajs/configuration';
import _ from 'lodash';
import { FingerprintProvider, TwoFactorAuthProvider } from '../interfaces';
import { QueueClient } from '@spinajs/queue';

import { NotLoggedPolicy } from '../policies/NotLoggedPolicy';
import { LoggedPolicy } from '../policies/LoggedPolicy';
import { UserPasswordRestore } from '../events/UserPassordRestore';
import { RestorePasswordDto } from '../dto/restore-password-dto';

import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import { UserAction } from 'rbac/src/models/UserTimeline';

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

  @Config('rbac.password_reset.ttl')
  protected PasswordResetTonekTTL: number;

  @AutoinjectService('rbac.twoFactorAuth.provider')
  protected TwoFactorAuthProvider: TwoFactorAuthProvider;

  @AutoinjectService('rbac.fingerprint.provider')
  protected FingerprintPrivider: FingerprintProvider;

  @Autoinject(FederatedAuthProvider)
  protected FederatedLoginStrategies: FederatedAuthProvider<any>[];

  @Autoinject(QueueClient)
  protected Queue: QueueClient;

  @Post('federated-login')
  @Policy(NotLoggedPolicy)
  public async loginFederated(@Body() credentials: unknown, @Header('Host') caller: string) {
    const strategy = this.FederatedLoginStrategies.find((x) => x.callerCheck(caller));
    if (!strategy) {
      throw new InvalidOperation(`No auth stragegy registered for caller ${caller}`);
    }

    const result = await strategy.authenticate(credentials);
    if (!result.Error) {
      // proceed with standard authentication
      return await this.authenticate(result.User);
    }

    return new Unauthorized(result.Error);
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
  @Policy(NotLoggedPolicy)
  public async login(@Body() credentials: UserLoginDto) {
    const result = await this.AuthProvider.authenticate(credentials.Email, credentials.Password);

    if (!result.Error) {
      // proceed with standard authentication
      return await this.authenticate(result.User);
    }

    return new Unauthorized(result.Error);
  }

  @Post('new-password')
  @Policy(NotLoggedPolicy)
  public async setNewPassword(@Query() token: string, @Body() pwd: RestorePasswordDto) {
    UserModel.where({}).populate

    const meta = await UserMetadata.where({
      Key: 'reset_password_token',
      Value: token,
    }).first();

    if (!meta) {
      return new InvalidOperation('Invalid reset token');
    }

    await meta.User.populate();
    await meta.User.Value.Metadata.populate();

    const user = meta.User.Value;

    const rTime = user.Metadata.find((x) => x.Key === 'reset_password_time').asISODate();
  }

  @Post('forgot-password')
  @Policy(NotLoggedPolicy)
  public async forgotPassword(@Body() login: UserLoginDto) {
    const user = await this.AuthProvider.get(login.Email);

    if (!user.IsActive || user.IsBanned || user.DeletedAt !== null) {
      return new BadRequest('User is inactive, banned or deleted. Contact system administrator');
    }

    const token = uuidv4();

    await user.Metadata.populate();

    await this.Queue.emit(new UserPasswordRestore(user.Uuid, token));

    await user.Metadata.add(
      new UserMetadata({
        Key: 'reset_password',
        Value: true,
      }),
      InsertBehaviour.InsertOrUpdate,
    );

    await user.Metadata.add(
      new UserMetadata({
        Key: 'reset_password_token',
        Value: token,
      }),
    );

    await user.Metadata.add(
      new UserMetadata({
        Key: 'reset_password_time',
        Value: DateTime.now().toISO(),
      }),
    );

    await user.Actions.add(
      new UserAction({
        Action: 'password_reset',
        Data: DateTime.now().toISO(),
        Persistend: true,
      }),
    );

    return new Ok({
      reset_token: token,
      ttl: this.PasswordResetTonekTTL,
    });
  }

  @Get()
  @Policy(LoggedPolicy)
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
