import { Forbidden } from '@spinajs/exceptions';
import { ActionHookFailed, ActionRefused } from '@spinajs/hooks';

/**
 * Runs `work`; an ActionRefused or ActionHookFailed of one of `actions` (the route's own) becomes 403
 * `{ error: 'action_refused', code }`, `hook_error` for a hook that failed. Any other error, a nested action's
 * refusal included, is rethrown.
 */
export async function asActionRefusal<T>(actions: readonly string[], work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const code = err instanceof ActionRefused && actions.includes(err.action) ? err.code : err instanceof ActionHookFailed && actions.includes(err.action) ? 'hook_error' : undefined;
    if (code === undefined) throw err;
    // @spinajs/http spreads the error's own props into the 403 body.
    throw Object.assign(new Forbidden('the action was refused'), { error: 'action_refused', code });
  }
}
