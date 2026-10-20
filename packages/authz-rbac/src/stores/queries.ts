import { AuthzAdminFailure, GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { IWhereBuilder } from '@spinajs/orm';

/** Live at `at`: no expiry, or one strictly after `at` (a row expiring exactly at `at` is gone). */
export function whereLive(query: IWhereBuilder<unknown>, at: Date): void {
  query.where(function () {
    this.whereNull('expires_at').orWhere('expires_at', '>', at);
  });
}

/** `limit` clamped to `max`; a negative, fractional or NaN `limit` or `offset` is `invalid_page`. */
export function pageWindow(page: { readonly limit: number; readonly offset: number } | undefined, max: number, where: string): { limit: number; offset: number } {
  for (const [name, value] of Object.entries(page ?? {})) {
    if (!Number.isInteger(value) || value < 0) {
      throw new AuthzAdminFailure('invalid_page', `${where}: page.${name} must be a non-negative integer, got ${String(value)}`, 'page');
    }
  }
  return { limit: Math.min(page?.limit ?? max, max), offset: page?.offset ?? 0 };
}

/** Refuses GLOBAL and type-level refs (`wrong_scope_type`); `rule` says why a scope node is needed. */
export function requireScopeNode(scope: ResourceRef, where: string, rule: string): void {
  if (scope?.type === GLOBAL.type || !scope?.id) {
    throw new AuthzAdminFailure('wrong_scope_type', `${where}: ${rule}, not ${scope?.type === GLOBAL.type ? 'GLOBAL' : `the type-level ref ${scope?.type}`}`, 'scope');
  }
}
