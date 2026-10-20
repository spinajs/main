import type { AuthzCommandResult } from '@spinajs/authz';

const REFUSED = new Set(['forbidden', 'escalation', 'last_holder', 'self_lockout', 'protected_role']);

/** The HTTP status of an AuthzAdminError code: refusals 403, not_found 404, conflict 409, the rest (validation) 400. */
export function adminErrorStatus(code: string): number {
  if (REFUSED.has(code)) return 403;
  if (code === 'not_found') return 404;
  if (code === 'conflict') return 409;
  return 400;
}

/** 200 when every command succeeded, else the status of the failed one (a batch reports its first failure). */
export function resultsStatus(results: readonly AuthzCommandResult[]): number {
  const failed = results.find((r) => !r.ok);
  return failed && !failed.ok ? adminErrorStatus(failed.error.code) : 200;
}
