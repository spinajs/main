import { AutoinjectService } from '@spinajs/configuration';
import { BaseController, BasePath, Body, Ok, Patch, Policy } from '@spinajs/http';
import { FromModel } from '@spinajs/orm-http';
import { grant, revoke, User } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource, User as CurrentUser } from '@spinajs/rbac-http';
import { Schema } from '@spinajs/validation';

import { RoleGuard } from '../../interfaces.js';

// Side effect only — see the note in Users.ts.
import '../../services/RoleGuard.js';

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
 *
 * Both routes run the configured {@link RoleGuard} before touching anything: a
 * role is the one thing in this API that can grant MORE than the caller has, so
 * "may update users" is not by itself an answer to "may hand out this role".
 * @tags Admin Users
 */
@BasePath('users/role')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Roles extends BaseController {
  @AutoinjectService('rbac.admin.roleGuard')
  protected RoleGuard: RoleGuard;

  /**
   * Grant role to user (admin)
   * Assigns the specified RBAC role to the user identified by login name.
   * @security cookieAuth
   * @param login User login name
   * @response 200 Role granted successfully
   * @response 400 Unknown role name
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required, or the role grants more than the caller holds
   * @response 404 User not found
   */
  @Patch('add/:login')
  @Permission(['updateAny'])
  public async addRole(@CurrentUser() actor: User, @FromModel({ queryField: 'Login', paramField: 'login', include: ['Metadata'] }) user: User, @Body() roleDto: RoleDto) {
    await this.RoleGuard.assertCanAssignRoles(actor, user, [roleDto.role]);
    await grant(user, roleDto.role);

    return new Ok();
  }

  /**
   * Revoke role from user (admin)
   * Removes the specified RBAC role from the user identified by login name.
   * @security cookieAuth
   * @param login User login name
   * @response 200 Role revoked successfully
   * @response 400 Unknown role name
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required, or the revocation would lock the caller or the installation out
   * @response 404 User not found
   */
  @Patch('revoke/:login')
  @Permission(['updateAny'])
  public async revokeRole(@CurrentUser() actor: User, @FromModel({ queryField: 'Login', paramField: 'login', include: ['Metadata'] }) user: User, @Body() roleDto: RoleDto) {
    await this.RoleGuard.assertCanRevokeRole(actor, user, roleDto.role);
    await revoke(user, roleDto.role);

    return new Ok();
  }
}
