import { PasswordDto } from '../dto/password-dto.js';
import { User as UserModel, PasswordProvider, SessionProvider, passwordMatch, changePassword, _unwindGrants, _combineGrants, AccessControl } from '@spinajs/rbac';
import { BaseController, BasePath, Get, Ok, Body, Patch, Cookie, Policy } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Autoinject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import * as cs from 'cookie-signature';
import _ from 'lodash';
import { AuthorizedPolicy, Permission, Resource, User, IGrantsMap } from '@spinajs/rbac-http';
import { _chain, _either } from '@spinajs/util';



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

  @Config('http.cookie.secret')
  protected CoockieSecret: string;

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
  public async refresh(@User() user: UserModel, @Cookie() ssid: string) {
    // get user data from db
    await user.refresh();
    await user.Metadata.populate();

    // refresh session data from DB
    const sId: string | false = cs.unsign(ssid, this.CoockieSecret);
    if (sId) {
      const session = await this.SessionProvider.restore(sId);
      if (session) {
        // Session stores the user UUID (see LoginController) — RbacUserFactory
        // resolves the user from it on each request. Storing a dehydrated object
        // here would break that lookup and log the user out on the next request.
        session.Data.set('User', user.Uuid);
        await this.SessionProvider.save(session);
      }
    }

    return new Ok(user.dehydrate());
  }

  /**
   * Get current user grants
   * Returns the flattened RBAC grants for the authenticated user, combining all roles
   * the user is assigned to into a single permission map keyed by resource.
   * @security cookieAuth
   * @returns {IGrantsMap} Combined RBAC grants map: resource → action → permission descriptor
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — insufficient permissions
   */
  @Get("grants")
  @Permission(['readOwn'])
  public async getGrants(@User() user: UserModel): Promise<Ok<IGrantsMap>> {

    const grants = this.AC.getGrants();
    const userGrants = user.Role.map(r => _unwindGrants(r, grants));

    // Object.assign merges at the resource level, so a role naming a resource an earlier role
    // also names would drop that role's actions on it — _combineGrants merges per action.
    const combinedGrants = _combineGrants(...userGrants);

    return new Ok(combinedGrants);
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
