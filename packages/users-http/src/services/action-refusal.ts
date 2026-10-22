/**
 * Runs `work`; an ActionRefused or ActionHookFailed of one of `actions` (the route's own) becomes 403
 * `{ error: 'action_refused', code }`. Any other error, a nested action's refusal included, is rethrown.
 */
export async function asActionRefusal<T>(_actions: readonly string[], _work: () => Promise<T>): Promise<T> {
  throw new Error('not implemented: asActionRefusal');
}
