import { RoleSource } from '@spinajs/authn/contracts';
import type {} from '@spinajs/authn/hooks';
import { Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';

/** The role a new session starts narrowed to; unset or null leaves it with every held role. */
export const INITIAL_ROLE_KEY = 'authz.principals.roleSwitch.initial';

export interface InitialRoleConfig {
  readonly order: readonly string[];
}

/**
 * A before hook on `authn.session.start` for `authz.principals.roleSwitch.initial`: with `{ order }`, a session that a
 * login or an MFA completion starts is narrowed, as by a role switch, to the first role of `order` the user holds (the
 * RoleSource's roles, those `GET /auth/active-role` lists). The user switches away from it as from any role switch.
 * With the key unset or null, no listed role held, no RoleSource registered, or a ceiling an earlier hook set, the
 * session start is left as it is.
 */
@Injectable(ActionHook)
export class OrderedActiveRoleHook extends ActionHook<'authn.session.start'> {
  readonly actions: readonly ActionPattern[] = ['authn.session.start'];

  @Config(INITIAL_ROLE_KEY)
  protected Initial: InitialRoleConfig | null | undefined;

  @Autoinject(RoleSource, { optional: true })
  protected Roles: RoleSource | undefined;

  public async before(ctx: BeforeContext<'authn.session.start'>): Promise<void> {
    const order = this.Initial?.order;
    if (!order || order.length === 0 || !this.Roles || ctx.input.ceiling !== undefined) return;
    const held = new Set((await this.Roles.rolesOf(ctx.input.principal)).map((r) => r.role));
    const first = order.find((role) => held.has(role));
    if (first !== undefined) ctx.input.ceiling = { roles: [first] };
  }
}
