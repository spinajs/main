import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';

import { TokenProfilePolicy } from './profile-policy.js';
import '../hooks.js';

/** The code TokenProfileHook refuses with; `DbTokenService.create` answers it as `invalid_scope`, as it always did. */
export const PROFILE_REFUSED = 'profile_refused';

/** A TokenProfileHook's `order`: before the hooks of the default order, so they only see a profile the policy allows. */
export const TOKEN_PROFILE_HOOK_ORDER = -1000;

/**
 * The create-time check of a token's profile: a before hook on `authn.token.create` that refuses a `profile` that is
 * not a non-empty string the registered {@link TokenProfilePolicy} allows the owner. `DbTokenService.create` answers the
 * refusal `{ ok: false, code: 'invalid_scope' }` and audits nothing, as before 3.x. The policy is still asked on every
 * validate, so a pinned token whose profile is no longer allowed stops authenticating.
 *
 * Registered by authn-token.
 */
@Injectable(ActionHook)
export class TokenProfileHook extends ActionHook<'authn.token.create'> {
  readonly actions: readonly ActionPattern[] = ['authn.token.create'];
  readonly order: number = TOKEN_PROFILE_HOOK_ORDER;

  @Autoinject(Container)
  protected Container!: IContainer;

  public async before(ctx: BeforeContext<'authn.token.create'>): Promise<void> {
    const opts: unknown = ctx.input.opts;
    const profile: unknown = opts !== null && typeof opts === 'object' ? (opts as { profile?: unknown }).profile : undefined;
    if (profile === undefined) return;
    if (typeof profile !== 'string' || profile.length === 0 || !(await (await this.policy()).allowedProfiles(ctx.input.owner)).includes(profile)) {
      ctx.refuse(PROFILE_REFUSED);
    }
  }

  protected async policy(): Promise<TokenProfilePolicy> {
    return this.Container.resolve<TokenProfilePolicy>(TokenProfilePolicy);
  }
}
