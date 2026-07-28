import { AutoinjectService } from '@spinajs/configuration';
import { BaseController, BasePath, Get, Ok, Param, Policy } from '@spinajs/http';
import { _user, UserProfileProvider } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from "@spinajs/rbac-http";


/**
 * User profile management (admin).
 * Provides administrative access to user profile data via the configured UserProfileProvider.
 * @tags Admin Users
 */
@BasePath('users/profile')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Profile extends BaseController {


    // NOTE: the provider is configured at `rbac.user.profile` ( see the rbac
    // package config ). Pointing at the unprefixed `user.profile` resolved
    // nothing — AutoinjectService only warns on a missing path, so the field
    // stayed undefined and every request died with
    // "Cannot read properties of undefined (reading 'retrieve')".
    @AutoinjectService('rbac.user.profile')
    protected ProfileService: UserProfileProvider;

    /**
     * Get user profile by login (admin)
     * Retrieves extended profile data for the specified user via the configured UserProfileProvider.
     * The shape of the returned profile depends on the active provider implementation.
     * @security cookieAuth
     * @param login User login name
     * @returns {IUserProfile} User profile data as returned by the configured UserProfileProvider
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — readAny permission required on users resource
     * @response 404 User not found
     */
    @Get(':login')
    @Permission(['readAny'])
    public async getUserProfile(@Param() login: string) {
         return new Ok(this.ProfileService.retrieve(login));
    }
}
