import { RoleSource, SessionStartHook } from '@spinajs/authn/contracts';
import type { Ceiling, Principal, SessionHandle, SessionIssuer } from '@spinajs/authn/contracts';
import { Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';

/** The role a new session starts narrowed to; unset or null leaves it with every held role. */
export const INITIAL_ROLE_KEY = 'authz.principals.roleSwitch.initial';

export interface InitialRoleConfig {
  readonly order: readonly string[];
}

/**
 * authn's SessionStartHook for `authz.principals.roleSwitch.initial`: with `{ order }`, a session that a login or an MFA
 * completion starts is narrowed, as by a role switch, to the first role of `order` the user holds (the RoleSource's
 * roles, those `GET /auth/active-role` lists). The user switches away from it as from any role switch. With the key
 * unset or null, no listed role held or no RoleSource registered, the session keeps every held role.
 */
@Injectable(SessionStartHook)
export class OrderedActiveRoleHook extends SessionStartHook {
  @Config(INITIAL_ROLE_KEY)
  protected Initial: InitialRoleConfig | null | undefined;

  @Autoinject(RoleSource, { optional: true })
  protected Roles: RoleSource | undefined;

  public async onStart(_kind: 'login' | 'mfa', _session: SessionHandle, principal: Principal, _sessions: SessionIssuer): Promise<Ceiling | undefined> {
    const order = this.Initial?.order;
    if (!order || order.length === 0 || !this.Roles) return undefined;
    const held = new Set((await this.Roles.rolesOf(principal)).map((r) => r.role));
    const first = order.find((role) => held.has(role));
    return first === undefined ? undefined : { roles: [first] };
  }
}
