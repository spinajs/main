import { ImpersonationGuard } from '@spinajs/authn/contracts';
import type {} from '@spinajs/authn/hooks';
import { Autoinject, Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import { isPlainObject } from '@spinajs/util';

/**
 * The impersonation start check: a before hook on `authn.impersonation.start` that asks the registered
 * ImpersonationGuard (users' AuthzImpersonationGuard, or an app's subclass of it) about the actor and the target, and
 * refuses with the code it answers. authn audits the refusal as `hook:<code>`; the guard still ends the impersonation
 * on any later request it refuses.
 */
@Injectable(ActionHook)
export class ImpersonationGuardStartHook extends ActionHook<'authn.impersonation.start'> {
  readonly actions: readonly ActionPattern[] = ['authn.impersonation.start'];

  @Autoinject(ImpersonationGuard)
  protected Guard: ImpersonationGuard;

  public async before(ctx: BeforeContext<'authn.impersonation.start'>): Promise<void> {
    const answer: unknown = await this.Guard.allowed(ctx.input.actor, ctx.input.target);
    if (isPlainObject(answer) && answer.ok === true) return;
    ctx.refuse(isPlainObject(answer) && typeof answer.code === 'string' ? answer.code : 'forbidden');
  }
}
