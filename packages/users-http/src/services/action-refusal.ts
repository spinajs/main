import { Forbidden } from '@spinajs/exceptions';
import { withProblemFields } from '@spinajs/http';
import { ActionHookFailed, ActionRefused } from '@spinajs/hooks';

/** The refusals of AccountDisableHook: answered 403 with the reason, as the account guard answered them. */
const ACCOUNT_RULES: ReadonlySet<string> = new Set(['self_lockout', 'last_holder']);
const DISABLING: ReadonlySet<string> = new Set(['users.deactivate', 'users.ban', 'users.delete']);

/**
 * Runs `work`; an ActionRefused or ActionHookFailed of one of `actions` (the route's own) becomes 403
 * `{ error: 'action_refused', code }`, `hook_error` for a hook that failed; a `self_lockout` or `last_holder` refusal
 * of an action that takes an account out of service is 403 with its reason. Any other error, a nested action's
 * refusal included, is rethrown.
 */
export async function asActionRefusal<T>(actions: readonly string[], work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ActionRefused && actions.includes(err.action) && DISABLING.has(err.action) && ACCOUNT_RULES.has(err.code)) {
      throw new Forbidden(err.message);
    }
    const code = err instanceof ActionRefused && actions.includes(err.action) ? err.code : err instanceof ActionHookFailed && actions.includes(err.action) ? 'hook_error' : undefined;
    if (code === undefined) throw err;
    // @spinajs/http spreads the error's own props into the 403 body.
    throw withProblemFields(new Forbidden('the action was refused'), { error: 'action_refused', code });
  }
}
