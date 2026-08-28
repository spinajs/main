import { ImpersonateDto } from '../dto/impersonate-dto.js';
import { BaseController, BasePath, Post, Del, Body, Ok, Get, BadRequestResponse, Unauthorized, ForbiddenResponse, Conflict, NotFound, Policy } from '@spinajs/http';
import {
  AccessControl,
  PasswordProvider,
  User,
  UserImpersonationStarted,
  canImpersonate,
  userModel,
} from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { _ev } from '@spinajs/queue';
import { DateTime } from 'luxon';
import {
  LoggedPolicy,
  User as UserRouteArg,
  Session as SessionRouteArg,
  FromSession,
  IImpersonationResponse,
  IImpersonationState,
  IUserWithGrants,
} from '@spinajs/rbac-http';
import { ImpersonationService } from '../services/ImpersonationService.js';
import { SessionCookieFactory } from '../services/SessionCookies.js';
import { buildUserWithGrants, grantsFor } from '../services/grants.js';

const IMPERSONATE_RESOURCE = 'user:impersonate';

/**
 * Impersonation endpoints.
 *
 * A user holding `createAny` on the virtual resource `user:impersonate` can
 * temporarily act as another user. While impersonation is active, the session
 * carries both identities — `User` is the target, `Impersonator` is the
 * original. Permission checks therefore "see" the target by default; the
 * original is preserved only for audit and for ending the impersonation.
 *
 * @tags Impersonation
 */
@BasePath('auth')
export class ImpersonationController extends BaseController {
  @Autoinject(AccessControl)
  protected AC: AccessControl;

  @AutoinjectService('rbac.password')
  protected PasswordProvider: PasswordProvider;

  @Autoinject(ImpersonationService)
  protected Impersonation: ImpersonationService;

  @Autoinject(SessionCookieFactory)
  protected SessionCookies: SessionCookieFactory;

  @Config('rbac.impersonation.requirePassword', { defaultValue: true })
  protected RequirePassword: boolean;

  @Config('rbac.impersonation.protectedRoles', { defaultValue: ['system'] as string[] })
  protected ProtectedRoles: string[];

  /**
   * Get impersonation state
   * Returns whether an impersonation is currently active for this session.
   * @security cookieAuth
   * @returns {IImpersonationState}
   * @response 401 No active session
   */
  @Get('impersonate')
  @Policy(LoggedPolicy)
  public async getState(
    @FromSession() Impersonator: string,
    @FromSession() User: string,
    @FromSession() ImpersonationStartedAt: string,
  ): Promise<Ok<IImpersonationState>> {
    if (!Impersonator) {
      return new Ok({ Active: false });
    }
    return new Ok({
      Active: true,
      ImpersonatorUuid: Impersonator,
      TargetUuid: User,
      StartedAt: ImpersonationStartedAt,
    });
  }

  /**
   * Start impersonation
   * Begins impersonating the target user. The caller must have `createAny` on
   * virtual resource `user:impersonate`. The target must not hold any role in
   * `rbac.impersonation.protectedRoles` and must not have effective grants
   * exceeding the caller's. If `rbac.impersonation.requirePassword` is true,
   * the caller's password must be supplied and is verified.
   * @security cookieAuth
   * @returns {IImpersonationResponse}
   * @response 400 Target equals caller or invalid payload
   * @response 401 Password required or invalid
   * @response 403 Caller lacks permission, target is protected, or escalation detected
   * @response 404 Target user not found / inactive / banned / deleted
   * @response 409 An impersonation is already in progress for this session
   */
  @Post('impersonate')
  @Policy(LoggedPolicy)
  public async start(
    @UserRouteArg() caller: User,
    @SessionRouteArg() session: ISession,
    @Body() payload: ImpersonateDto,
  ): Promise<
    Ok<IImpersonationResponse> | BadRequestResponse | Unauthorized | ForbiddenResponse | NotFound | Conflict
  > {
    if (this.Impersonation.isActive(session)) {
      return new Conflict({
        error: {
          code: 'E_IMPERSONATION_ACTIVE',
          message: 'An impersonation is already in progress. Stop the current one before starting another.',
        },
      });
    }

    if (caller.Uuid === payload.TargetUuid) {
      return new BadRequestResponse({
        error: { code: 'E_SELF_IMPERSONATION', message: 'Cannot impersonate yourself' },
      });
    }

    // Permission to impersonate is itself an RBAC permission honoring ActiveRole.
    const activeRole = (session?.Data.get('ActiveRole') as string | undefined) ?? caller.Role?.[0];
    const roles = activeRole ? [activeRole] : caller.Role;
    const allowed = (this.AC.can(roles) as any).createAny(IMPERSONATE_RESOURCE).granted;
    if (!allowed) {
      return new ForbiddenResponse({
        error: { code: 'E_IMPERSONATE_FORBIDDEN', message: `Role(s) ${roles} cannot impersonate other users` },
      });
    }

    const target = await this.loadTarget(payload.TargetUuid);
    if (!target) {
      return new NotFound({ error: { code: 'E_TARGET_NOT_FOUND', message: 'Target user not found' } });
    }
    if (!target.IsActive || target.IsBanned) {
      return new NotFound({ error: { code: 'E_TARGET_UNAVAILABLE', message: 'Target user is not available' } });
    }

    const check = canImpersonate({
      originalRoles: caller.Role,
      targetRoles: target.Role,
      protectedRoles: this.ProtectedRoles ?? [],
      ac: this.AC,
    });
    if (!check.allowed) {
      return new ForbiddenResponse({
        error: {
          code: check.reason === 'PROTECTED_ROLE' ? 'E_TARGET_PROTECTED' : 'E_PRIVILEGE_ESCALATION',
          message: check.reason === 'PROTECTED_ROLE'
            ? `Target has a protected role (${check.detail}) and cannot be impersonated`
            : `Target has a privilege the impersonator lacks (${check.detail})`,
        },
      });
    }

    if (this.RequirePassword) {
      if (!payload.Password) {
        return new Unauthorized({
          error: { code: 'E_PASSWORD_REQUIRED', message: 'Password confirmation is required to start impersonation' },
        });
      }
      const valid = await this.PasswordProvider.verify(caller.Password, payload.Password);
      if (!valid) {
        return new Unauthorized({ error: { code: 'E_PASSWORD_INVALID', message: 'Invalid password' } });
      }
    }

    // Persist impersonation state. The service keeps the impersonator's
    // previous ActiveRole so it can be restored on stop; effective ActiveRole
    // becomes the target's first role.
    const startedAt = DateTime.now().toISO()!;
    const { Session: regenerated, ActiveRole: targetActiveRole } = await this.Impersonation.start(session, caller, target, startedAt);

    await this.emitEvent(new UserImpersonationStarted(caller, target));

    // The session id changed with the identity — hand the client the new one or
    // its next request arrives with a session that no longer exists.
    return new Ok(this.buildResponse(target, caller, targetActiveRole, startedAt), {
      Coockies: [this.SessionCookies.issue(regenerated)],
      Headers: [{ Name: 'Cache-Control', Value: 'no-store' }],
    });
  }

  /**
   * Stop impersonation
   * Restores the original user's session and returns their login-style payload.
   * @security cookieAuth
   * @returns {IUserWithGrants}
   * @response 400 No impersonation is currently active
   */
  @Del('impersonate')
  @Policy(LoggedPolicy)
  public async stop(
    @UserRouteArg() target: User,
    @SessionRouteArg() session: ISession,
  ): Promise<Ok<IUserWithGrants> | BadRequestResponse> {
    const result = await this.Impersonation.revert(session, target);

    if (result.Status === 'not-impersonating') {
      return new BadRequestResponse({
        error: { code: 'E_NO_IMPERSONATION', message: 'No impersonation is currently in progress' },
      });
    }

    if (result.Status === 'impersonator-gone') {
      // Stale session referencing a deleted impersonator. The service already
      // cleared the impersonation block to recover; report an error so the
      // caller can re-authenticate.
      return new BadRequestResponse({
        error: { code: 'E_IMPERSONATOR_GONE', message: 'Original user no longer exists' },
      });
    }

    return new Ok(buildUserWithGrants(result.Original, result.ActiveRole, this.AC), {
      Coockies: [this.SessionCookies.issue(result.Session)],
      Headers: [{ Name: 'Cache-Control', Value: 'no-store' }],
    });
  }

  /**
   * Emit an impersonation lifecycle event. Wrapped in a protected method so
   * tests can intercept without stubbing module-level ESM bindings.
   */
  protected async emitEvent(event: UserImpersonationStarted): Promise<void> {
    await _ev(event)();
  }

  /**
   * Load the impersonation target (with Metadata so IsBanned works). Extracted
   * as a protected method so tests can stub it without setting up a database.
   */
  protected loadTarget(uuid: string): Promise<User | undefined> {
    return userModel().query().whereUuid(uuid).populate('Metadata').notDeleted().first() as Promise<User | undefined>;
  }

  protected buildResponse(
    target: User,
    impersonator: User,
    activeRole: string | undefined,
    startedAt: string,
  ): IImpersonationResponse {
    return {
      User: target.dehydrateWithRelations({ dateTimeFormat: 'iso' }) as any,
      Impersonator: impersonator.dehydrateWithRelations({ dateTimeFormat: 'iso' }) as any,
      ActiveRole: activeRole,
      Grants: grantsFor(this.AC, activeRole),
      StartedAt: startedAt,
    } as IImpersonationResponse;
  }
}
