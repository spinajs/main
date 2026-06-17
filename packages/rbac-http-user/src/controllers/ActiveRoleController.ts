import { SwitchRoleDto } from '../dto/switchRole-dto.js';
import { BaseController, BasePath, Post, Body, Ok, Get, BadRequestResponse, Unauthorized, Policy } from '@spinajs/http';
import { AccessControl, AuthProvider, PasswordProvider, SessionProvider, _unwindGrants } from '@spinajs/rbac';
import type { ISession, User } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { LoggedPolicy, User as UserRouteArg, Session as SessionRouteArg, FromSession, IActiveRoleResponse } from '@spinajs/rbac-http';

/**
 * Active role endpoints.
 * Let users with multiple roles inspect and switch the currently active role.
 * The active role drives all request-bound permission checks; the user's full
 * role list remains available so they can switch back at any time.
 * @tags Authentication
 */
@BasePath('auth')
export class ActiveRoleController extends BaseController {
  @Autoinject(AccessControl)
  protected AC: AccessControl;

  @AutoinjectService('rbac.auth')
  protected AuthProvider: AuthProvider;

  @AutoinjectService('rbac.password')
  protected PasswordProvider: PasswordProvider;

  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

  @Config('rbac.roleSwitch.requirePassword', { defaultValue: [] as string[] })
  protected RolesRequiringPassword: string[];

  /**
   * Get active role
   * Returns the currently active role for the session and the RBAC grants
   * resolved for the active role. Roles the user may switch to are in User.Role.
   * @security cookieAuth
   * @returns {IActiveRoleResponse}
   * @response 401 No active session
   */
  @Get('active-role')
  @Policy(LoggedPolicy)
  public async getActiveRole(@UserRouteArg() user: User, @FromSession() ActiveRole: string): Promise<Ok<IActiveRoleResponse>> {
    return new Ok(this.buildResponse(ActiveRole ?? user.Role?.[0]));
  }

  /**
   * Switch active role
   * Switches the active role for the current session. The requested role must be one of
   * the user's assigned roles. If the role is listed in `rbac.roleSwitch.requirePassword`,
   * the user's password must also be provided and is re-verified.
   * @security cookieAuth
   * @returns {IActiveRoleResponse}
   * @response 400 Requested role is not assigned to the user
   * @response 401 Password verification required or failed
   */
  @Post('active-role')
  @Policy(LoggedPolicy)
  public async switchActiveRole(
    @UserRouteArg() user: User,
    @SessionRouteArg() session: ISession,
    @Body() payload: SwitchRoleDto,
  ): Promise<Ok<IActiveRoleResponse> | BadRequestResponse | Unauthorized> {
    if (!user.Role?.includes(payload.Role)) {
      return new BadRequestResponse({
        error: {
          code: 'E_ROLE_NOT_ASSIGNED',
          message: `Role '${payload.Role}' is not assigned to user`,
        },
      });
    }

    if (this.RolesRequiringPassword?.includes(payload.Role)) {
      if (!payload.Password) {
        return new Unauthorized({
          error: {
            code: 'E_PASSWORD_REQUIRED',
            message: `Password is required to activate role '${payload.Role}'`,
          },
        });
      }

      const valid = await this.PasswordProvider.verify(user.Password, payload.Password);
      if (!valid) {
        return new Unauthorized({
          error: {
            code: 'E_PASSWORD_INVALID',
            message: 'Invalid password',
          },
        });
      }
    }

    session.Data.set('ActiveRole', payload.Role);
    await this.SessionProvider.save(session);

    return new Ok(this.buildResponse(payload.Role));
  }

  protected buildResponse(activeRole: string): IActiveRoleResponse {
    const grants = activeRole ? _unwindGrants(activeRole, this.AC.getGrants()) : {};
    return {
      ActiveRole: activeRole,
      Grants: grants,
    };
  }
}
