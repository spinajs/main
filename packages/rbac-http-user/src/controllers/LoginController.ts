import { UserLoginDto } from '../dto/userLogin-dto.js';
import { BaseController, BasePath, Post, Body, Ok, Get, Cookie, Unauthorized, Policy } from '@spinajs/http';
import { AuthProvider, SessionProvider, auth, UserSession, AccessControl, _unwindGrants } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService, Config, Configuration } from '@spinajs/configuration';
import _ from 'lodash';
import { LoggedPolicy, NotLoggedPolicy, User as UserRouteArg } from '@spinajs/rbac-http';
import { User } from '@spinajs/rbac';
@BasePath('auth')
export class LoginController extends BaseController {
  @Autoinject()
  protected Configuration: Configuration;

  @AutoinjectService('rbac.auth')
  protected AuthProvider: AuthProvider;

  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

  @Config('rbac.session.expiration', {
    defaultValue: 120,
  })
  protected SessionExpirationTime: number;

  @Config('rbac.twoFactorAuth.enabled', {
    defaultValue: false,
  })
  protected TwoFactorAuthEnabled: boolean;



  @Config('rbac.session.cookie', {})
  protected SessionCookieConfig: any;

  @Autoinject(AccessControl)
  protected AC: AccessControl;

  @Post()
  @Policy(NotLoggedPolicy)
  public async login(@Body() credentials: UserLoginDto) {
    try {
      const user = await auth(credentials.Email, credentials.Password);
      const session = new UserSession();
      const coockies = [
        {
          Name: 'ssid',
          Value: session.SessionId,
          Options: {
            signed: true,
            httpOnly: true,

            // set expiration time in ms
            maxAge: this.SessionExpirationTime * 1000,

            // any optopnal cookie options
            // or override default ones
            ...this.SessionCookieConfig
          },
        },
      ];
      session.Data.set('User', user.Uuid);
      // set expiration time ( default val in config )
      session.extend();
      await this.SessionProvider.save(session);

      if (this.TwoFactorAuthEnabled) {

        this._log.trace('User logged in, 2fa required', {
          Uuid: user.Uuid
        });

        session.Data.set('Authorized', false);
        session.Data.set('TwoFactorAuth', true);

        return new Ok({
          TwoFactorAuthRequired: true,
          Authorized: false
        }, {
          Coockies: coockies,
        })
      }

      this._log.trace('User logged in, no 2fa required', {
        Uuid: user.Uuid
      });

      const grants = this.AC.getGrants();
      const userGrants = user.Role.map(r => _unwindGrants(r, grants));
      const combinedGrants = Object.assign({}, ...userGrants);

      return new Ok({
        ...user.dehydrateWithRelations({ 
          dateTimeFormat: "iso"
        }),
        Grants: combinedGrants,
      }, {
        Coockies: coockies
      });

    } catch (err) {
      this._log.error(err);

      return new Unauthorized({
        error: {
          code: 'E_AUTH_FAILED',
          message: 'login or password incorrect',
        },
      });
    }
  }

  @Get()
  @Policy(LoggedPolicy)
  public async logout(@Cookie() ssid: string) {
    if (!ssid) {
      return new Ok();
    }

    await this.SessionProvider.delete(ssid);

    // send empty cookie to confirm session deletion
    return new Ok(null, {
      Coockies: [
        {
          Name: 'ssid',
          Value: '',
          Options: {
            httpOnly: true,
            maxAge: 0,

            // any optopnal cookie options
            // or override default ones
            ...this.SessionCookieConfig
          },
        },
      ],
    });
  }

  @Get()
  @Policy(LoggedPolicy)
  public async whoami(@UserRouteArg() User: User) {

    // user is taken from session data
    return new Ok(User);
  }

  // protected async authenticate(user: UserModel, federated?: boolean) {
  //   if (!user) {
  //     return new Unauthorized({
  //       error: {
  //         message: 'login or password incorrect',
  //       },
  //     });
  //   }

  //   await user.Metadata.populate();

  //   const session = new Session();
  //   const dUser = user.dehydrate();
  //   session.Data.set('User', dUser);

  //   // we found user but we still dont know if is authorized
  //   // eg. 2fa auth is not performed
  //   // create session, but user is not yet authorized
  //   session.Data.set('Authorized', false);

  //   // if its federated login, skip 2fa - assume
  //   // external login service provided it
  //   if (this.TwoFactorConfig.enabled || !federated) {
  //     await this.SessionProvider.save(session);

  //     const enabledForUser = await this.TwoFactorAuthProvider.isEnabled(user);

  //     /**
  //      * if 2fa is enabled for user, proceed
  //      */
  //     if (enabledForUser) {
  //       /**
  //        * check if 2fa system is initialized for user eg. private key is generated.
  //        */
  //       const isInitialized = await this.TwoFactorAuthProvider.isInitialized(user);
  //       if (!isInitialized) {
  //         const twoFaResult = await this.TwoFactorAuthProvider.initialize(user);

  //         return new CookieResponse(
  //           'ssid',
  //           session.SessionId,
  //           this.SessionExpirationTime,
  //           true,
  //           {
  //             toFactorAuth: true,
  //             twoFactorAuthFirstTime: true,
  //             method: this.TwoFactorConfig.service,
  //             data: twoFaResult,
  //           },
  //           { httpOnly: true },
  //         );
  //       }

  //       // give chance to execute 2fa eg. send sms or email
  //       await this.TwoFactorAuthProvider.execute(user);

  //       // return session to identify user
  //       // and only info that twoFactor auth is requested
  //       return new CookieResponse(
  //         'ssid',
  //         session.SessionId,
  //         this.SessionExpirationTime,
  //         true,
  //         {
  //           toFactorAuth: true,
  //         },
  //         { httpOnly: true },
  //       );
  //     }
  //   }

  //   // 2fa is not enabled, so we found user, it means it is logged
  //   session.Data.set('Authorized', true);
  //   await this.SessionProvider.save(session);

  //   await this.Queue.emit(new UserLoginSuccess(user.Uuid));

  //   user.LastLoginAt = DateTime.now();
  //   await user.update();

  //   // BEWARE: httpOnly coockie, only accesible via http method in browser
  //   // return coockie session id with additional user data
  //   return new CookieResponse('ssid', session.SessionId, this.SessionExpirationTime, true, dUser, { httpOnly: true });
  // }
}


