import { BaseController, BasePath, Body, Ok, Param, Patch, Policy } from '@spinajs/http';
import { _user, grant, revoke } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from "@spinajs/rbac-http";
import { Schema } from '@spinajs/validation';


@Schema({
    type: 'object',
    $id: 'arrow.common.roleDTO',
    properties: {
        role: { type: 'string', minLength: 1, maxLength: 32, description: 'RBAC role name to grant or revoke' },
    },
    required: ['role'],
})
export class RoleDto {
    public role: string;

    constructor(data: Partial<RoleDto>) {
        Object.assign(this, data);
    }
}


/**
 * User role management (admin).
 * Grants and revokes RBAC roles for user accounts.
 * @tags Admin Users
 */
@BasePath('users/role')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Roles extends BaseController {
    /**
     * Grant role to user (admin)
     * Assigns the specified RBAC role to the user identified by login name.
     * @security cookieAuth
     * @param login User login name
     * @response 200 Role granted successfully
     * @response 400 Invalid role name
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — updateAny permission required on users resource
     * @response 404 User not found
     */
    @Patch('add/:login')
    @Permission(['updateAny'])
    public async addRole(@Param() login: string, @Body() roleDto: RoleDto) {
        await grant(login, roleDto.role);
        return new Ok()
    }
    
    /**
     * Revoke role from user (admin)
     * Removes the specified RBAC role from the user identified by login name.
     * @security cookieAuth
     * @param login User login name
     * @response 200 Role revoked successfully
     * @response 400 Invalid role name
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — updateAny permission required on users resource
     * @response 404 User not found
     */
    @Patch('revoke/:login')
    @Permission(['updateAny'])
    public async revokeRole(@Param() login: string, @Body() roleDto: RoleDto) {
        await revoke(login, roleDto.role);
        return new Ok()
    }
}
