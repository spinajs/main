import type { ImpersonationGuard } from '@spinajs/authn/contracts';
import type {} from '@spinajs/authn/hooks';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';

/**
 * The impersonation start check as users registers it: a before hook on `authn.impersonation.start` that asks the guard
 * `guard()` returns about the input's actor and target, and refuses with the code it answers.
 */
export class FakeImpersonationStartHook extends ActionHook<'authn.impersonation.start'> {
  readonly actions: readonly ActionPattern[] = ['authn.impersonation.start'];

  constructor(private readonly guard: () => ImpersonationGuard) {
    super();
  }

  async before(ctx: BeforeContext<'authn.impersonation.start'>): Promise<void> {
    const answer = await this.guard().allowed(ctx.input.actor, ctx.input.target);
    if (!answer.ok) ctx.refuse(answer.code);
  }
}
