import { ActionHook } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext } from '@spinajs/hooks';
import '@spinajs/authn-local';

/** Keeps the users row in step with authn-local's password flows. */
export class UserPasswordStateHook extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['authn.password.change', 'authn.password.set', 'authn.password.reset.redeem'];

  public after(_ctx: AfterContext<ActionName>): Promise<void> {
    throw new Error('not implemented: UserPasswordStateHook.after');
  }
}
