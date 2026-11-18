import { Exception } from '@spinajs/exceptions';
import type { TenantRunReport } from './contracts.js';

/** Code that needs one tenant ran with no scope, or in the cross-tenant scope. */
export class TenantRequired extends Exception {}

/** A change of scope that would swap one tenant for another, or that a guard refused. */
export class TenantSwitchDenied extends Exception {}

/** A value names another tenant than the one in scope. */
export class TenantMismatch extends Exception {}

export type TenantUnavailableReason = 'unknown' | 'inactive' | 'forbidden';

/** The tenant is not known to the registry, is not active, or the principal may not enter it. */
export class TenantUnavailable extends Exception {
  constructor(
    public readonly reason: TenantUnavailableReason,
    message: string,
  ) {
    super(message);
  }
}

/** `forEachTenant` stopped because the registry failed; `cause` is the registry's error, `report` covers the tenants that ran before. */
export class TenantIterationAborted extends Exception {
  constructor(
    message: string,
    public readonly report: TenantRunReport,
    cause: unknown,
  ) {
    super(message, cause);
  }
}
