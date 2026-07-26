import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import { AccessControl, User as RbacUser } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AuthorizedPolicy } from '../policies/AuthorizedPolicy.js';
import { User } from '../decorators.js';
import { IGrantsMap } from '../interfaces.js';

/**
 * RBAC grants management.
 * Provides access to the current RBAC access-control grants configuration.
 * @tags RBAC
 */
@BasePath('grants')
@Policy(AuthorizedPolicy)
export class GrantsController extends BaseController {

    @Autoinject(AccessControl)
    protected AC: AccessControl;

    /**
     * Get RBAC grants
     * Returns the RBAC grants for the requesting user's own role(s) only — not
     * the full cross-role matrix, which would leak the entire access-control
     * policy to any authenticated user.
     * @security cookieAuth
     * @returns {IGrantsMap} RBAC grants map keyed by the caller's role name(s)
     * @response 401 Unauthorized — valid session cookie required
     */
    @Get()
    public getGrants(@User() user: RbacUser): Ok<IGrantsMap> {
        const allGrants = this.AC.getGrants() as IGrantsMap;
        const roles = user?.Role ?? [];

        const filtered: IGrantsMap = {};
        for (const role of roles) {
            if (allGrants[role]) {
                filtered[role] = allGrants[role];
            }
        }

        return new Ok(filtered);
    }

}
