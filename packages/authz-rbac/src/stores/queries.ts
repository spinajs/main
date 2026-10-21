import { AuthzAdminFailure, GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { IWhereBuilder } from '@spinajs/orm';
import type { DateTime } from 'luxon';

import { cursorWithOffset, decodeCursor, encodeCursor, invalidCursor } from './cursor.js';

/** Live at `at`: no expiry, or one strictly after `at` (a row expiring exactly at `at` is gone). */
export function whereLive(query: IWhereBuilder<unknown>, at: Date): void {
  query.where(function () {
    this.whereNull('expires_at').orWhere('expires_at', '>', at);
  });
}

/** A page of an ordered (created_at, id) list: the rows after the cursor when there is one, else after `offset`. */
export interface ListWindow {
  readonly limit: number;
  readonly offset: number;
  readonly after?: { readonly createdAt: Date; readonly id: string };
}

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * `limit` clamped to `max`; a negative, fractional or NaN `limit` or `offset`, a cursor this list did not
 * issue, and a cursor together with an `offset` are `invalid_page`.
 */
export function pageWindow(page: { readonly limit: number; readonly offset: number; readonly after?: string } | undefined, max: number, where: string): ListWindow {
  for (const name of ['limit', 'offset'] as const) {
    const value = page?.[name];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new AuthzAdminFailure('invalid_page', `${where}: page.${name} must be a non-negative integer, got ${String(value)}`, 'page');
    }
  }
  const window = { limit: Math.min(page?.limit ?? max, max), offset: page?.offset ?? 0 };
  if (page?.after === undefined) return window;

  if (window.offset > 0) throw cursorWithOffset(where);
  const [stamp, id] = decodeCursor(page.after, 2, where);
  const createdAt = new Date(stamp);
  if (!ISO_MILLIS.test(stamp) || Number.isNaN(createdAt.getTime())) throw invalidCursor(where);
  return { ...window, after: { createdAt, id } };
}

/** Rows strictly after the cursor in (created_at, id) order. */
function whereAfter(query: IWhereBuilder<unknown>, after: { readonly createdAt: Date; readonly id: string }): void {
  query.where(function () {
    this.where('created_at', '>', after.createdAt).orWhere(function () {
      this.where('created_at', after.createdAt).where('id', '>', after.id);
    });
  });
}

/** Narrows an (created_at, id) ordered query to the window, with one row more than the limit so `trimWindow` can tell whether another page follows. */
export function applyWindow<Q extends IWhereBuilder<unknown> & { take(count: number): unknown; skip(count: number): unknown }>(query: Q, window: ListWindow): Q {
  if (window.after) whereAfter(query, window.after);
  else if (window.offset > 0) query.skip(window.offset);
  query.take(window.limit + 1);
  return query;
}

/** The rows of the window and, when more follow a first or cursor page, the cursor of its last row; an offset page gets none. */
export function trimWindow<R extends { readonly id: string; readonly created_at: DateTime }>(rows: readonly R[], window: ListWindow): { rows: readonly R[]; next?: string } {
  if (rows.length <= window.limit) return { rows };
  const page = rows.slice(0, window.limit);
  if (window.offset > 0) return { rows: page };
  const last = page[page.length - 1];
  return { rows: page, next: encodeCursor(new Date(last.created_at.toMillis()).toISOString(), last.id) };
}

/** Refuses GLOBAL and type-level refs (`wrong_scope_type`); `rule` says why a scope node is needed. */
export function requireScopeNode(scope: ResourceRef, where: string, rule: string): void {
  if (scope?.type === GLOBAL.type || !scope?.id) {
    throw new AuthzAdminFailure('wrong_scope_type', `${where}: ${rule}, not ${scope?.type === GLOBAL.type ? 'GLOBAL' : `the type-level ref ${scope?.type}`}`, 'scope');
  }
}
