import { PasswordDto } from '../dto/password-dto.js';
import { User as UserModel, PasswordProvider, SessionProvider, passwordMatch, changePassword, AccessControl } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { BaseController, BasePath, Get, Ok, Body, Patch, Cookie, Policy } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Autoinject } from '@spinajs/di';
import _ from 'lodash';
import { AuthorizedPolicy, Permission, Resource, User, IGrantsMap, Session as SessionRouteArg } from '@spinajs/rbac-http';
import { _chain, _either } from '@spinajs/util';
import { activeRoleOf, grantsFor } from '../services/grants.js';



/**
 * Current user profile management.
 * Allows an authenticated user to read and modify their own account — refresh profile data,
 * view their RBAC grants, and change their password.
 * @tags User
 */
@BasePath('user')
@Resource('user')
@Policy(AuthorizedPolicy)
export class UserController extends BaseController {
  @Autoinject()
  protected PasswordProvider: PasswordProvider;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  @Autoinject(AccessControl)
  protected AC: AccessControl;

  /**
   * Refresh current user profile
   * Reloads the authenticated user's record from the database (including metadata) and
   * updates the session with the latest data. Returns the refreshed user data.
   * @security cookieAuth
   * @returns {IUserProfile} Refreshed user profile data
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — insufficient permissions
   */
  @Get()
  @Permission(['readOwn'])
  public async refresh(@User() user: UserModel, @Cookie(true) ssid: string) {
    // get user data from db
    await user.refresh();
    await user.Metadata.populate();

    // `@Cookie(true)` hands over the already-unsigned session id — the previous
    // unsigned read plus a hand-rolled `cookie-signature` call duplicated what
    // the framework's own extractor does, secret lookup included.
    if (ssid) {
      const session = await this.SessionProvider.restore(ssid);
      if (session) {
        // Session stores the user UUID (see LoginController) — RbacUserFactory
        // resolves the user from it on each request. Storing a dehydrated object
        // here would break that lookup and log the user out on the next request.
        session.Data.set('User', user.Uuid);
        await this.SessionProvider.save(session);
      }
    }

    // Same shape as every other user-bearing response ( login, whoami, 2FA
    // verify ): relations included and DateTime rendered as ISO strings. Plain
    // `dehydrate()` dropped Role/Metadata and emitted raw DateTime objects, so
    // a client refreshing its profile got a different user than it logged in with.
    return new Ok(user.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
  }

  /**
   * Get current user grants
   * Returns the flattened RBAC grants in effect for the authenticated user — those of
   * the session's active role, resolved through its inheritance chain. Switching the
   * active role (`POST /auth/active-role`) changes what this returns.
   * @security cookieAuth
   * @returns {IGrantsMap} RBAC grants map for the active role: resource → action → permission descriptor
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — insufficient permissions
   */
  @Get("grants")
  @Permission(['readOwn'])
  public async getGrants(@User() user: UserModel, @SessionRouteArg() session: ISession): Promise<Ok<IGrantsMap>> {
    // Enforcement is bound to the session's ActiveRole, so reporting the union
    // of every assigned role told clients about actions the server would then
    // refuse — a user holding both 'admin' and 'user' saw admin grants while
    // acting as 'user'. Resolve exactly what the middleware resolves.
    return new Ok(grantsFor(this.AC, activeRoleOf(user, session)));
  }


  /**
   * Change own password
   * Changes the authenticated user's password. Requires the current (old) password for verification.
   * The new password and its confirmation must match.
   * @security cookieAuth
   * @response 400 Old password is incorrect, or new passwords do not match
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — insufficient permissions
   */
  @Patch('password')
  @Permission(["updateOwn"])
  public async newPassword(@User() user: UserModel, @Body() pwd: PasswordDto) {
    if (pwd.Password !== pwd.ConfirmPassword) {
      throw new InvalidArgument('password does not match');
    }


    return new Ok(
      _chain(
        user,
        _either(
          passwordMatch(pwd.OldPassword),
          changePassword(pwd.Password),
          () => {
            throw new InvalidArgument('Old password is incorrect');
          }),
      ),
    );
  }
}
