import { AuthzConfigError, isPermission } from '@spinajs/authz';
import type { Permission, ResourceRef } from '@spinajs/authz';
import { DeleteQueryBuilder, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';

import { marksOf, setMarks } from '../marker.js';
import { entryOf } from '../registry.js';

export interface AccessibleOptions {
  /** Request env for the plan (ABAC env facts); none unless given. */
  readonly env?: Readonly<Record<string, unknown>>;
}

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    /** Only rows `permission` allows the current principal (design §6.2). */
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    /** No access filter, audited (`authz.audit.unscoped`). */
    unscoped(reason: string): this;
    /** Only rows that are one of `ref` or descend from one (authz_resource_ancestor); narrows, does not authorize. */
    within(ref: ResourceRef | readonly ResourceRef[]): this;
    /** `$access` per row for each permission (design §10.3). */
    withAccess(permissions: readonly Permission[], opts?: AccessibleOptions): this;
  }
  interface SelectQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
    /** Only rows that are one of `ref` or descend from one (authz_resource_ancestor); narrows, does not authorize. */
    within(ref: ResourceRef | readonly ResourceRef[]): this;
    withAccess(permissions: readonly Permission[], opts?: AccessibleOptions): this;
  }
  interface IUpdateQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
    /** Only rows that are one of `ref` or descend from one (authz_resource_ancestor); narrows, does not authorize. */
    within(ref: ResourceRef | readonly ResourceRef[]): this;
  }
  interface UpdateQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
    /** Only rows that are one of `ref` or descend from one (authz_resource_ancestor); narrows, does not authorize. */
    within(ref: ResourceRef | readonly ResourceRef[]): this;
  }
  interface IDeleteQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
    /** Only rows that are one of `ref` or descend from one (authz_resource_ancestor); narrows, does not authorize. */
    within(ref: ResourceRef | readonly ResourceRef[]): this;
  }
  interface DeleteQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
    /** Only rows that are one of `ref` or descend from one (authz_resource_ancestor); narrows, does not authorize. */
    within(ref: ResourceRef | readonly ResourceRef[]): this;
  }
}

function requireResource(builder: object, what: string): void {
  const model = (builder as { Model?: unknown }).Model;
  if (!entryOf(model)) throw new AuthzConfigError(`${what}: the query is not on an @AccessResource model (${typeof model === 'function' && model.name ? model.name : 'no model'})`);
}

function envOf(opts: AccessibleOptions | undefined, what: string): { env?: Readonly<Record<string, unknown>> } {
  if (opts === undefined || opts.env === undefined) return {};
  if (opts.env === null || typeof opts.env !== 'object' || Array.isArray(opts.env)) throw new AuthzConfigError(`${what}: env must be an object`);
  return { env: opts.env };
}

function accessible(this: object, permission: Permission, opts?: AccessibleOptions): object {
  const what = `.accessible(${JSON.stringify(permission)})`;
  requireResource(this, what);
  if (!isPermission(permission)) throw new AuthzConfigError(`${what}: not a permission name`);
  const marks = marksOf(this) ?? {};
  if (marks.unscoped !== undefined) throw new AuthzConfigError(`${what}: .accessible() and .unscoped() exclude each other`);
  if (marks.accessible !== undefined && marks.accessible !== permission) throw new AuthzConfigError(`${what}: the query is already .accessible(${JSON.stringify(marks.accessible)}); a query lists by one permission`);
  setMarks(this, { ...marks, accessible: permission, ...envOf(opts, what) });
  return this;
}

function unscoped(this: object, reason: string): object {
  const what = `.unscoped(${JSON.stringify(reason)})`;
  requireResource(this, what);
  if (typeof reason !== 'string' || reason.trim() === '') throw new AuthzConfigError('.unscoped() needs a reason');
  const marks = marksOf(this) ?? {};
  if (marks.accessible !== undefined) throw new AuthzConfigError(`${what}: .accessible() and .unscoped() exclude each other`);
  setMarks(this, { ...marks, unscoped: reason });
  return this;
}

function refsOf(v: unknown): readonly ResourceRef[] {
  const list: unknown[] = Array.isArray(v) ? v : [v];
  return Object.freeze(
    list.map((r) => {
      const ref = r as { type?: unknown; id?: unknown } | null;
      const ok = ref !== null && typeof ref === 'object' && typeof ref.type === 'string' && ref.type !== '' && (ref.id === undefined || typeof ref.id === 'string');
      if (!ok) throw new AuthzConfigError(`.within(): a ref is { type, id? } with string values, got ${JSON.stringify(r)}`);
      return Object.freeze(ref.id === undefined ? { type: ref.type as string } : { type: ref.type as string, id: ref.id as string });
    }),
  );
}

function within(this: object, ref: ResourceRef | readonly ResourceRef[]): object {
  requireResource(this, '.within()');
  const refs = refsOf(ref);
  const marks = marksOf(this) ?? {};
  setMarks(this, { ...marks, within: Object.freeze([...(marks.within ?? []), refs]) });
  return this;
}

function withAccess(this: object, permissions: readonly Permission[], opts?: AccessibleOptions): object {
  const what = '.withAccess()';
  requireResource(this, what);
  if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every((p) => isPermission(p))) throw new AuthzConfigError(`${what}: needs a non-empty list of permission names`);
  const marks = marksOf(this) ?? {};
  setMarks(this, { ...marks, withAccess: Object.freeze([...new Set(permissions)]), ...envOf(opts, what) });
  return this;
}

for (const proto of [SelectQueryBuilder.prototype, UpdateQueryBuilder.prototype, DeleteQueryBuilder.prototype] as unknown as Record<string, unknown>[]) {
  proto.accessible = accessible;
  proto.unscoped = unscoped;
  proto.within = within;
}
(SelectQueryBuilder.prototype as unknown as Record<string, unknown>).withAccess = withAccess;

// A clone is the same query: it keeps what the caller declared (clone() runs no middleware, builders.ts:1299).
const clone = SelectQueryBuilder.prototype.clone;
SelectQueryBuilder.prototype.clone = function (this: SelectQueryBuilder) {
  const copy = clone.call(this);
  const marks = marksOf(this);
  if (marks !== undefined) setMarks(copy, marks);
  return copy;
} as typeof clone;
