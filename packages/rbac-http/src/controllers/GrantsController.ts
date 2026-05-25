import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import { AccessControl } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AuthorizedPolicy } from '../policies/AuthorizedPolicy.js';
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
     * Returns the full RBAC grants object defining roles and their permissions across resources.
     * @security cookieAuth
     * @returns {IGrantsMap} RBAC grants map keyed by role name
     * @response 401 Unauthorized — valid session cookie required
     */
    @Get()
    public getGrants(): Ok<IGrantsMap> {
        return new Ok(this.AC.getGrants());
    }

}
