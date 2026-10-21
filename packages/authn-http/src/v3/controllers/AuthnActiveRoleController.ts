import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, Body, Get, Ok, Policy, Post } from '@spinajs/http';
import { PrincipalFactory, RoleSource, SessionIssuer } from '@spinajs/authn/contracts';
import type { Session } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { AuthnActiveRoleBody, ROLE_CAP } from '../../dto/active-role.js';
import { OnInvalidInput, byField, unknownField } from '../../validation/answers.js';
import { uniformFailure } from '../../validation/login.js';
import type { AuthnClientContext } from '../client.js';

import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, RoleSourceRegistered } from '../index.js';
import { refused, unauthenticated } from '../../policies/v3/errors.js';
import { freshAuthOrAnswer } from '../../policies/v3/fresh-auth.js';
import { activeSessionOf } from '../../policies/v3/principal.js';
import { ACTIVE_ROLE_KEY } from '../../resolvers/session.js';
import { NO_STORE, authnSessionCookie } from '../responses.js';
import { answerFor, onLiveSession } from '../routes.js';

const invalidRole = (): BadRequestResponse => new BadRequestResponse({ error: 'invalid_role', message: `role must be a non-empty string of at most ${ROLE_CAP} characters` });

/**
 * The role switch (A26, D14): a session narrows its principal to one role it holds, as `ceiling.roles`. Off (404)
 * while no RoleSource or no PrincipalFactory is registered. A role the RoleSource marks `requirePassword` needs fresh
 * authentication: a login within authn.freshAuth.maxAgeSeconds, or the password in the body, verified through the
 * throttled re-authentication (A13, SR-20). The switch rotates the session id, then stores the role (N2).
 * @tags Authentication
 */
@BasePath('auth')
@Policy(RoleSourceRegistered)
export class AuthnActiveRoleController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  @Autoinject(PrincipalFactory, { optional: true })
  protected Principals: PrincipalFactory | undefined;

  @Autoinject(RoleSource, { optional: true })
  protected Roles: RoleSource | undefined;

  /**
   * Get the active role
   * `ActiveRole` (null before any switch: every held role applies) and the roles RoleSource gives.
   * @returns {AuthnActiveRoleState} The active role and the roles held
   * @response 401 {AuthnError} No session
   * @security cookieAuth
   */
  @Get('active-role')
  @Policy([Authenticated, NoTokenAuthPolicy])
  public async state(@ClientContext() client: AuthnClientContext) {
    const session = activeSessionOf(client);
    return new Ok({ ActiveRole: session.activeRole ?? null, Roles: await this.held(session) }, { Headers: [NO_STORE] });
  }

  /**
   * Switch the active role
   * Body `{ role, password? }`. 400 for a malformed role (`invalid_field` for an unknown field), 403 for a role not held, 401 with the login failure body when the password fails or is no string (no Retry-After). Not while impersonating.
   * @body {AuthnActiveRoleBody} The role, and the password when the role asks for a fresh one
   * @returns {AuthnRoleSwitchAnswer} The principal summary narrowed to the role
   * @response 400 {AuthnError} invalid_role
   * @response 401 {AuthnUnauthorized} No session, or the inline password or code failed (the login failure body)
   * @response 403 {AuthnError} role_not_held, fresh_auth_required, session_required or impersonating
   * @security cookieAuth
   */
  @Post('active-role')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  @OnInvalidInput(byField({ role: invalidRole, password: uniformFailure }, unknownField))
  public async switch(@Body({ required: true, sensitive: ['password'] }) body: AuthnActiveRoleBody, @ClientContext() client: AuthnClientContext) {
    const { role } = body;
    const session = activeSessionOf(client);
    const entry = (await this.held(session)).find((r) => r.role === role);
    if (!entry) throw refused('role_not_held', 'the caller does not hold this role');
    // Anything but an explicit false asks for the password.
    if (entry.requirePassword !== false) {
      const fresh = await freshAuthOrAnswer(this.Container, client, body.password);
      if ('answer' in fresh) return fresh.answer;
    }

    const sessions = this.Sessions;
    const rotated = await onLiveSession(() => sessions.rotate(session.handle));
    await onLiveSession(() => sessions.set(rotated, ACTIVE_ROLE_KEY, role));
    const now = await sessions.restore(rotated.id);
    if (!now) throw unauthenticated('the session has ended');
    const factory = this.Principals!;
    const principal = await factory.principalOf(now.identity, now.facts, { ceiling: { roles: [role] } });
    return new Ok(await answerFor(this.Container, 'role-switch', principal, { ActiveRole: role }), { Coockies: [authnSessionCookie(this._cfg, rotated)], Headers: [NO_STORE] });
  }

  /** The roles of the session's identity without the current narrowing, so a narrowed session can switch back. */
  protected async held(session: Session): Promise<{ role: string; requirePassword: boolean }[]> {
    const factory = this.Principals!;
    const principal = await factory.principalOf(session.identity, session.facts, {});
    const roles = await this.Roles!.rolesOf(principal);
    return roles.map((r) => ({ role: r.role, requirePassword: r.requirePassword }));
  }
}
