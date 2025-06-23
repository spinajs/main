import { UserLoginDto } from '../dto/userLogin-dto.js';
import { BaseController, BasePath, Post, Body, Ok, Get, Cookie, Unauthorized, Policy } from '@spinajs/http';
import { AuthProvider, SessionProvider, login, UserSession, AccessControl, _unwindGrants } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService, Config, Configuration } from '@spinajs/configuration';
import _ from 'lodash';
import { LoggedPolicy, NotAuthorizedPolicy, User as UserRouteArg } from '@spinajs/rbac-http';
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


  @Config('rbac.twoFactorAuth.forceUser', {
    defaultValue: false,
  })
  protected TwoFactorAuthForceUser: boolean;

  @Config('rbac.session.cookie', {})
  protected SessionCookieConfig: any;

  @Autoinject(AccessControl)
  protected AC: AccessControl;

  @Post()
  @Policy(NotAuthorizedPolicy)
  public async login(@Body() credentials: UserLoginDto) {
    try {
      const user = await login(credentials.Email, credentials.Password);
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
      let result: any = {};

      session.Data.set('User', user.Uuid);

      // we have two states for user
      // LOGGED - when user use proper login/password and session is created
      // AUTHORIZED - when user is atuhenticated eg. by 2fa check. If 2fa is disabled
      //              user is automatically authorized at login
      session.Data.set('Logged', true);

      // set expiration time ( default val in config )
      session.extend();

      
      if (this.TwoFactorAuthForceUser && !user.Metadata['2fa:enabled']) {
        this._log.trace('User logged in, 2fa init required', {
          Uuid: user.Uuid
        });

        session.Data.set('Authorized', false);
        session.Data.set('TwoFactorAuth', true);

        result = {
          TwoFactorInitRequired: true,
          Authorized: false
        };
      }
      else {
        if (this.TwoFactorAuthEnabled && user.Metadata['2fa:enabled']) {

          this._log.trace('User logged in, 2fa required', {
            Uuid: user.Uuid
          });

          session.Data.set('Authorized', false);
          session.Data.set('TwoFactorAuth', true);

          result = {
            TwoFactorAuthRequired: true,
            Authorized: false
          };
        } else {

          session.Data.set('Authorized', true);

          const grants = this.AC.getGrants();
          const userGrants = user.Role.map(r => _unwindGrants(r, grants));
          const combinedGrants = Object.assign({}, ...userGrants);

          result = {
            ...user.dehydrateWithRelations({
              dateTimeFormat: "iso"
            }),
            Grants: combinedGrants,
          };
        }
      }

      this._log.trace('User logged in, no 2fa required', {
        Uuid: user.Uuid
      });


      await this.SessionProvider.save(session);

      return new Ok(result, {
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
}


