import { UserLoginDto } from '../dto/userLogin-dto.js';
import { BaseController, BasePath, Post, Body, Ok, Get, Cookie, Unauthorized, Policy } from '@spinajs/http';
import { AuthProvider, SessionProvider, login, UserSession, AccessControl, _unwindGrants } from '@spinajs/rbac';
import { Autoinject, DI } from '@spinajs/di';
import { AutoinjectService, Config, Configuration } from '@spinajs/configuration';
import _ from 'lodash';
import { LoggedPolicy, User as UserRouteArg, Session as SessionRouteArg, FromSession, ILoginResponse, IUserWithGrants, SkipModelPermission } from '@spinajs/rbac-http';
import { User } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { LogoutHandler, ILogoutContext } from '../logout.js';


/**
 * Authentication endpoints.
 * Handles user login, logout, and current-session inspection.
 * All session state is maintained via the signed `ssid` cookie.
 * @tags Authentication
 */
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

  /**
   * Login
   * Authenticates the user with email and password. On success, sets the signed `ssid` session cookie
   * and returns user data with their RBAC grants. When two-factor authentication is enabled and
   * configured for the user, the response instead signals that 2FA verification is required.
   * If the caller already has an active session it is invalidated before creating a new one.
   * @security []
   * @returns {ILoginResponse} On full login: IUserWithGrants. On 2FA required: ITwoFactorAuthRequired. On 2FA setup required: ITwoFactorInitRequired
   * @response 401 Invalid email or password
   */
  @Post()
  @SkipModelPermission()
  public async login(@UserRouteArg() logged: User, @Cookie(true) ssid: string, @Body() credentials: UserLoginDto): Promise<Ok<ILoginResponse> | Unauthorized> {
    try {

      // if logged user is already logged in, delete his session
      // then allow for new login
      if (logged && ssid) {
        await this.SessionProvider.delete(ssid);
      }

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
      let result: ILoginResponse;

      session.Data.set('User', user.Uuid);

      // Default active role = first role from the user's role list.
      // Users with multiple roles can later switch via /auth/active-role.
      const activeRole = user.Role?.[0];
      if (activeRole) {
        session.Data.set('ActiveRole', activeRole);
      }

      // we have two states for user
      // LOGGED - when user use proper login/password and session is created
      // AUTHORIZED - when user is atuhenticated eg. by 2fa check. If 2fa is disabled
      //              user is automatically authorized at login
      session.Data.set('Logged', true);
      session.UserId = user.Id;

      // set expiration time ( default val in config )
      session.extend();



      if (this.TwoFactorAuthForceUser && !user.Metadata['2fa:enabled']) {
        this._log.trace('User logged in, 2fa init required', {
          Uuid: user.Uuid
        });

        session.Data.set('Authorized', false);
        session.Data.set('TwoFactorAuth', true);

        result = { TwoFactorInitRequired: true };
      }
      else if (this.TwoFactorAuthEnabled && user.Metadata['2fa:enabled']) {

        this._log.trace('User logged in, 2fa required', {
          Uuid: user.Uuid
        });

        session.Data.set('Authorized', false);
        session.Data.set('TwoFactorAuth', true);

        result = { TwoFactorAuthRequired: true };
      } else {

        session.Data.set('Authorized', true);

        const grants = this.AC.getGrants();
        const combinedGrants = activeRole ? _unwindGrants(activeRole, grants) : {};

        // dehydrateWithRelations({ dateTimeFormat: 'iso' }) converts DateTime to ISO strings
        // at runtime — the ORM types don't reflect the dateTimeFormat option in generics
        result = {
          ...user.dehydrateWithRelations({ dateTimeFormat: "iso" }),
          Role: user.Role, // temp fix for role grants, as dehydrateWithRelations returns string of roles, not array
          ActiveRole: activeRole,
          Grants: combinedGrants,
        } as unknown as IUserWithGrants;
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

  /**
   * Logout
   * Destroys the current session identified by the `ssid` cookie and clears the cookie on the client.
   * If an impersonation is active, the session is NOT destroyed — instead the
   * impersonation is ended and the original user resumes their session.
   * Requires the user to be logged in (session exists), but full authorization (2FA) is not required.
   * @security cookieAuth
   * @response 401 No active session
   */
  @Get()
  @Policy(LoggedPolicy)
  public async logout(@Cookie(true) ssid: string, @SessionRouteArg() session: ISession, @UserRouteArg() user: User) {
    if (!ssid) {
      return new Ok();
    }

    // Delegate to the registered LogoutHandler chain. Each handler decides
    // whether to take ownership of the response (returns non-null) or defer
    // to the next handler. Built-ins:
    //  - ImpersonationLogoutHandler (priority 10): reverts an active
    //    impersonation and keeps the session alive.
    //  - DefaultLogoutHandler (priority 999): destroys the session and clears
    //    the ssid cookie.
    // Apps can register additional handlers via @Injectable(LogoutHandler).
    const handlers = await DI.resolve(Array.ofType(LogoutHandler));
    const sorted = [...handlers].sort((a, b) => a.Priority - b.Priority);

    const ctx: ILogoutContext = { Ssid: ssid, Session: session, User: user };
    for (const handler of sorted) {
      const result = await handler.handle(ctx);
      if (result) {
        return new Ok(result.Body ?? null, { Coockies: result.Cookies ?? [] });
      }
    }

    // No handler claimed the request — should not happen as long as the
    // default handler is registered, but return a clean response anyway.
    return new Ok();
  }

  /**
   * Get current user
   * Returns the user object associated with the current session along with the
   * currently active role. Roles the user may switch to are listed in Role.
   * Requires the user to be logged in (session exists), but full authorization (2FA) is not required.
   * @security cookieAuth
   * @returns {User} User data from the current session
   * @response 401 No active session
   */
  @Get()
  @Policy(LoggedPolicy)
  public async whoami(@UserRouteArg() User: User, @FromSession() ActiveRole: string) {

    return new Ok({
      ...User.dehydrateWithRelations({ dateTimeFormat: 'iso' }),
      ActiveRole: ActiveRole ?? User.Role?.[0],
    });
  }
}


