import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, Get, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { PrincipalFactory, RoleSource, SessionIssuer } from '@spinajs/authn/contracts';

import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, RoleSourceRegistered, assertFreshAuth } from '../index.js';
import { isAuthnFailed, refused, unauthenticated } from '../../policies/v3/errors.js';
import { ACTIVE_ROLE_KEY } from '../../resolvers/session.js';
import { NO_STORE, authnFailureResponse, authnSessionCookie } from '../responses.js';
import { answerFor, bodyField, boundedString, onLiveSession } from '../routes.js';
import type { Restored } from '../routes.js';

const ROLE_CAP = 256;

/**
 * The role switch (A26, D14): a session narrows its principal to one role it holds, as `ceiling.roles`. Off (404)
 * while no RoleSource is registered. A role the RoleSource marks `requirePassword` needs fresh authentication: a login
 * within authn.freshAuth.maxAgeSeconds, or the password in the body, verified through the throttled re-authentication
 * (A13, SR-20). The switch rotates the session id, then stores the role (N2).
 * @tags Authentication
 */
@BasePath('auth')
@Policy(RoleSourceRegistered)
export class AuthnActiveRoleController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * Get the active role
   * `ActiveRole` (null before any switch: every held role applies) and the roles RoleSource gives.
   * @security cookieAuth
   */
  @Get('active-role')
  @Policy([Authenticated, NoTokenAuthPolicy])
  public async state(@Req() req: Request) {
    const session = this.own(req);
    const role = session.data.get(ACTIVE_ROLE_KEY);
    return new Ok({ ActiveRole: typeof role === 'string' ? role : null, Roles: await this.held(session) }, { Headers: [NO_STORE] });
  }

  /**
   * Switch the active role
   * Body `{ role, password? }` (the 2.x `Role` and `Password` names work too). 400 for a malformed role, 403 for a
   * role not held, 401 with the login failure body when the password fails (no Retry-After). Not while impersonating.
   * @security cookieAuth
   */
  @Post('active-role')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async switch(@Req() req: Request) {
    const role = boundedString(bodyField(req, 'role', 'Role'), ROLE_CAP);
    if (role === null) return new BadRequestResponse({ error: 'invalid_role', message: `role must be a non-empty string of at most ${ROLE_CAP} characters` });
    const session = this.own(req);
    const entry = (await this.held(session)).find((r) => r.role === role);
    if (!entry) throw refused('role_not_held', 'the caller does not hold this role');
    // Anything but an explicit false asks for the password.
    if (entry.requirePassword !== false) {
      try {
        await assertFreshAuth(this.Container, req, undefined, bodyField(req, 'password', 'Password'));
      } catch (err) {
        if (isAuthnFailed(err)) return authnFailureResponse();
        throw err;
      }
    }

    const sessions = await this.Container.resolve(SessionIssuer);
    const rotated = await onLiveSession(() => sessions.rotate(session.handle));
    await onLiveSession(() => sessions.set(rotated, ACTIVE_ROLE_KEY, role));
    const now = await sessions.restore(rotated.id);
    if (!now) throw unauthenticated('the session has ended');
    const factory = await this.Container.resolve(PrincipalFactory);
    const principal = await factory.principalOf(now.identity, now.facts, { ceiling: { roles: [role] } });
    return new Ok(await answerFor(this.Container, 'role-switch', principal, { ActiveRole: role }), { Coockies: [authnSessionCookie(this._cfg, rotated)], Headers: [NO_STORE] });
  }

  protected own(req: Request): Restored {
    const session = req.storage.AuthnSession;
    if (session?.handle.state !== 'active') throw refused('session_required', 'this route needs a session');
    return session;
  }

  /** The roles of the session's identity without the current narrowing, so a narrowed session can switch back. */
  protected async held(session: Restored): Promise<{ role: string; requirePassword: boolean }[]> {
    const factory = await this.Container.resolve(PrincipalFactory);
    const principal = await factory.principalOf(session.identity, session.facts, {});
    const roles = await (await this.Container.resolve(RoleSource)).rolesOf(principal);
    return roles.map((r) => ({ role: r.role, requirePassword: r.requirePassword }));
  }
}
