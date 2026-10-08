import '../../registrations.js';
import { SwitchRoleDto } from '../dto/switchRole-dto.js';
import { BaseController, BasePath, Post, Body, Ok, Get, BadRequestResponse, Unauthorized, Policy } from '@spinajs/http';
import { AccessControl, AuthProvider, PasswordProvider, SessionProvider, regenerateSession } from '@spinajs/users';
import type { ISession, User } from '@spinajs/users';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { LoggedPolicy } from '../../policies/LoggedPolicy.js';
import { User as UserRouteArg, Session as SessionRouteArg, FromSession } from '../../decorators.js';
import { IActiveRoleResponse } from '../../interfaces.js';
import { resolveSessionContext } from '../../session-context.js';
import { SessionCookieFactory } from '../services/SessionCookies.js';
import { grantsFor } from '../services/grants.js';

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

  @AutoinjectService('authn.local.hasher')
  protected PasswordProvider: PasswordProvider;

  @AutoinjectService('authn.session')
  protected SessionProvider: SessionProvider;

  @Config('authz.principals.roleSwitch.requirePassword')
  protected RolesRequiringPassword: string[] | undefined;

  /** @deprecated the 2.x key, read only while the 3.0 key is unset */
  @Config('rbac.roleSwitch.requirePassword')
  protected LegacyRolesRequiringPassword: string[] | undefined;

  @Autoinject(SessionCookieFactory)
  protected SessionCookies: SessionCookieFactory;

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
    return new Ok(await this.buildResponse(user, ActiveRole ?? user.Role?.[0]));
  }

  /**
   * Switch active role
   * Switches the active role for the current session. The requested role must be one of
   * the user's assigned roles. If the role is listed in `authz.principals.roleSwitch.requirePassword`
   * (or, while that key is unset, the 2.x `rbac.roleSwitch.requirePassword`; with neither set, every role),
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

    if (this.requiresPassword(payload.Role)) {
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

    // Privilege elevation — regenerate the session id to defend against session
    // fixation, and reset the ssid cookie to the new id.
    const regenerated = await regenerateSession(this.SessionProvider, session);

    return new Ok(await this.buildResponse(user, payload.Role), {
      Coockies: [this.SessionCookies.issue(regenerated)],
    });
  }

  // Fails safe: with no list configured a switch always asks for the password.
  protected requiresPassword(role: string): boolean {
    const list = this.RolesRequiringPassword ?? this.LegacyRolesRequiringPassword;
    return !Array.isArray(list) || list.includes(role);
  }

  protected async buildResponse(user: User, activeRole: string): Promise<IActiveRoleResponse> {
    return {
      ...(await resolveSessionContext(user, activeRole)),
      ActiveRole: activeRole,
      Grants: grantsFor(this.AC, activeRole),
    };
  }
}
