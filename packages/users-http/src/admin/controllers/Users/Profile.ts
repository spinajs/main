import { AutoinjectService } from '@spinajs/configuration';
import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';
import { UserProfileProvider, userModel } from '@spinajs/users';
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';

import { userRowFor } from '../../../services/users-access.js';

/**
 * User profile management (admin).
 * Provides administrative access to user profile data via the configured UserProfileProvider.
 * The route sits on `@Access('users:read')`, decided on the addressed user's row.
 * @tags Admin Users
 */
@BasePath('users/profile')
export class Profile extends BaseController {
  // NOTE: the provider is configured at `users.user.profile` ( see the users
  // package config ). Pointing at the unprefixed `user.profile` resolved
  // nothing — AutoinjectService only warns on a missing path, so the field
  // stayed undefined and every request died with
  // "Cannot read properties of undefined (reading 'retrieve')".
  @AutoinjectService('users.user.profile')
  protected ProfileService: UserProfileProvider;

  /**
   * Get user profile by login (admin)
   * Retrieves extended profile data for the specified user via the configured UserProfileProvider.
   * The shape of the returned profile depends on the active provider implementation.
   * @security cookieAuth
   * @param login User login name (a uuid or an email address is accepted too)
   * @returns {IUserProfile} User profile data as returned by the configured UserProfileProvider
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:read` on this user
   * @response 404 User not found
   */
  @Get(':login')
  @Access('users:read', { fields: 'filter' })
  public async getUserProfile(@CurrentPrincipal() caller: Principal, @Param() login: string) {
    // The provider gets the row the decision was made on, not the identifier, so it cannot read another one.
    // whereAnything ORs its columns, so the soft-delete filter may not hold for all of them.
    const user = await userRowFor(caller, 'users:read', async () => {
      const found = await userModel().query().whereAnything(login).populate('Metadata').first();
      return found && !found.DeletedAt ? found : undefined;
    });

    // NOTE: awaited. Handing the pending promise to `Ok` serialized as an
    // empty object for every client that got JSON back.
    return new Ok(await this.ProfileService.retrieve(user));
  }
}
