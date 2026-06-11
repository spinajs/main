import { ImpersonateDto } from '../dto/impersonate-dto.js';
import { BaseController, BasePath, Post, Del, Body, Ok, Get, BadRequestResponse, Unauthorized, ForbiddenResponse, Conflict, NotFound, Policy } from '@spinajs/http';
import {
  AccessControl,
  PasswordProvider,
  SessionProvider,
  User,
  UserImpersonationStarted,
  UserImpersonationEnded,
  _unwindGrants,
  canImpersonate,
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
 * @tags Authentication
 */
@BasePath('auth')
export class ImpersonationController extends BaseController {
  @Autoinject(AccessControl)
  protected AC: AccessControl;

  @AutoinjectService('rbac.password')
  protected PasswordProvider: PasswordProvider;

  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

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
    if (session?.Data.get('Impersonator')) {
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

    // Persist impersonation state. We keep the impersonator's previous
    // ActiveRole so it can be restored on stop; effective ActiveRole becomes
    // the target's first role.
    const startedAt = DateTime.now().toISO()!;
    const previousActiveRole = session.Data.get('ActiveRole') as string | undefined;

    session.Data.set('Impersonator', caller.Uuid);
    session.Data.set('User', target.Uuid);
    session.Data.set('ImpersonationStartedAt', startedAt);
    if (previousActiveRole !== undefined) {
      session.Data.set('OriginalActiveRole', previousActiveRole);
    }
    const targetActiveRole = target.Role?.[0];
    if (targetActiveRole) {
      session.Data.set('ActiveRole', targetActiveRole);
    }

    await this.SessionProvider.save(session);
    await this.emitEvent(new UserImpersonationStarted(caller, target));

    return new Ok(this.buildResponse(target, caller, targetActiveRole!, startedAt));
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
    const impersonatorUuid = session?.Data.get('Impersonator') as string | undefined;
    if (!impersonatorUuid) {
      return new BadRequestResponse({
        error: { code: 'E_NO_IMPERSONATION', message: 'No impersonation is currently in progress' },
      });
    }

    const original = await this.loadOriginal(impersonatorUuid);
    if (!original) {
      // Stale session referencing a deleted impersonator — destroy the
      // impersonation block to recover but report an error so the caller
      // can re-authenticate.
      session.Data.delete('Impersonator');
      session.Data.delete('ImpersonationStartedAt');
      session.Data.delete('OriginalActiveRole');
      await this.SessionProvider.save(session);
      return new BadRequestResponse({
        error: { code: 'E_IMPERSONATOR_GONE', message: 'Original user no longer exists' },
      });
    }

    // Restore the original session state.
    session.Data.set('User', original.Uuid);
    session.Data.delete('Impersonator');
    session.Data.delete('ImpersonationStartedAt');

    const restoredActiveRole = (session.Data.get('OriginalActiveRole') as string | undefined) ?? original.Role?.[0];
    if (restoredActiveRole) {
      session.Data.set('ActiveRole', restoredActiveRole);
    }
    session.Data.delete('OriginalActiveRole');

    await this.SessionProvider.save(session);
    await this.emitEvent(new UserImpersonationEnded(original, target));

    const grants = restoredActiveRole ? _unwindGrants(restoredActiveRole, this.AC.getGrants()) : {};
    return new Ok({
      ...(original.dehydrateWithRelations({ dateTimeFormat: 'iso' }) as any),
      ActiveRole: restoredActiveRole,
      Grants: grants,
    } as IUserWithGrants);
  }

  /**
   * Emit an impersonation lifecycle event. Wrapped in a protected method so
   * tests can intercept without stubbing module-level ESM bindings.
   */
  protected emitEvent(event: UserImpersonationStarted | UserImpersonationEnded): Promise<void> {
    return _ev(event)();
  }

  /**
   * Load the impersonation target (with Metadata so IsBanned works). Extracted
   * as a protected method so tests can stub it without setting up a database.
   */
  protected loadTarget(uuid: string): Promise<User | undefined> {
    return User.query().whereUuid(uuid).populate('Metadata').notDeleted().first() as Promise<User | undefined>;
  }

  /**
   * Load the original (impersonator) user. Extracted for the same reason as
   * loadTarget — keeps the controller easy to test in isolation.
   */
  protected loadOriginal(uuid: string): Promise<User | undefined> {
    return User.getByUuid(uuid) as Promise<User | undefined>;
  }

  protected buildResponse(target: User, impersonator: User, activeRole: string, startedAt: string): IImpersonationResponse {
    const grants = activeRole ? _unwindGrants(activeRole, this.AC.getGrants()) : {};
    return {
      User: target.dehydrateWithRelations({ dateTimeFormat: 'iso' }) as any,
      Impersonator: impersonator.dehydrateWithRelations({ dateTimeFormat: 'iso' }) as any,
      ActiveRole: activeRole,
      AvailableRoles: target.Role ?? [],
      Grants: grants,
      StartedAt: startedAt,
    };
  }
}
