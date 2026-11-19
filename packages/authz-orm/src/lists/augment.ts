import { AuthzConfigError, isPermission } from '@spinajs/authz';
import type { Permission, ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryExtension, RelationType, SelectQueryExtension, UpdateQueryExtension } from '@spinajs/orm';
import type { QueryBuilder, QueryExtension } from '@spinajs/orm';

import { marksOf, setMarks } from '../marker.js';
import { entryOf } from '../registry.js';

export interface WithAccessOptions {
  /** Request env for the plan (ABAC env facts); none unless given. */
  readonly env?: Readonly<Record<string, unknown>>;
}

export interface AccessibleOptions extends WithAccessOptions {
  /** A `none` plan (nothing could grant the permission): `'deny'` throws AccessDenied (default, H16), `'empty'` matches no row. */
  readonly onNone?: 'deny' | 'empty';
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
    withAccess(permissions: readonly Permission[], opts?: WithAccessOptions): this;
  }
  interface SelectQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
    /** Only rows that are one of `ref` or descend from one (authz_resource_ancestor); narrows, does not authorize. */
    within(ref: ResourceRef | readonly ResourceRef[]): this;
    withAccess(permissions: readonly Permission[], opts?: WithAccessOptions): this;
    withFields(permission: Permission, opts?: WithAccessOptions): this;
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

function requireResource(builder: QueryBuilder, what: string): void {
  const model = builder.Model;
  if (!entryOf(model)) throw new AuthzConfigError(`${what}: the query is not on an @AccessResource model (${model !== undefined && model.name !== '' ? model.name : 'no model'})`);
}

const POPULATE_INSTEAD = 'Instead, filter the parent query, populate through a hasMany relation, or load the related rows with their own .accessible() query';

function manyToMany(relationName: string): string {
  return `in a populate callback: relation "${relationName}" is many-to-many: its junction query runs instead of this one, so the call would have no effect. ${POPULATE_INSTEAD}`;
}

/** Why a mark on this builder would not filter what the query returns, or undefined when it does. */
function markIgnored(builder: QueryBuilder): string | undefined {
  const { execution, owner } = builder.state();
  if (execution.kind === 'own') {
    // The junction query of a many-to-many relation runs on its own but selects from the junction table.
    return owner?.Descriptor.Type === RelationType.ManyToMany ? manyToMany(owner.Descriptor.Name) : undefined;
  }
  if (execution.kind === 'recursive') return `in a populate callback: relation "${execution.relation.Name}" is recursive: the recursive part of its query is built without the where, so its descendants would not be filtered. ${POPULATE_INSTEAD}`;
  if (execution.into === 'join') return 'in a join callback: the join query is merged into the parent query and never runs on its own, so the call would have no effect. Instead, filter the parent query or load the joined rows with their own .accessible() query';
  if (execution.into === 'parent') return `in a populate callback: relation "${execution.relation.Name}" is a belongsTo: its query is merged into the parent query and never runs on its own, so the call would have no effect. ${POPULATE_INSTEAD}`;
  return manyToMany(execution.relation.Name);
}

function requireOwnQuery(builder: QueryBuilder, what: string): void {
  const why = markIgnored(builder);
  if (why !== undefined) throw new AuthzConfigError(`${what} ${why}`);
}

function envOf(opts: WithAccessOptions | undefined, what: string): { env?: Readonly<Record<string, unknown>> } {
  if (opts === undefined || opts.env === undefined) return {};
  if (opts.env === null || typeof opts.env !== 'object' || Array.isArray(opts.env)) throw new AuthzConfigError(`${what}: env must be an object`);
  return { env: opts.env };
}

function onNoneOf(opts: AccessibleOptions | undefined, what: string): { onNone?: 'empty' } {
  const v = opts?.onNone;
  if (v === undefined || v === 'deny') return {};
  if (v === 'empty') return { onNone: v };
  throw new AuthzConfigError(`${what}: onNone must be 'deny' or 'empty', got ${JSON.stringify(v)}`);
}

function accessible(this: QueryBuilder, permission: Permission, opts?: AccessibleOptions): QueryBuilder {
  const what = `.accessible(${JSON.stringify(permission)})`;
  requireResource(this, what);
  requireOwnQuery(this, what);
  if (!isPermission(permission)) throw new AuthzConfigError(`${what}: not a permission name`);
  const marks = marksOf(this) ?? {};
  if (marks.unscoped !== undefined) throw new AuthzConfigError(`${what}: .accessible() and .unscoped() exclude each other`);
  if (marks.accessible !== undefined && marks.accessible !== permission) throw new AuthzConfigError(`${what}: the query is already .accessible(${JSON.stringify(marks.accessible)}); a query lists by one permission`);
  setMarks(this, { ...marks, accessible: permission, ...envOf(opts, what), ...onNoneOf(opts, what) });
  return this;
}

function unscoped(this: QueryBuilder, reason: string): QueryBuilder {
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

function within(this: QueryBuilder, ref: ResourceRef | readonly ResourceRef[]): QueryBuilder {
  requireResource(this, '.within()');
  requireOwnQuery(this, '.within()');
  const refs = refsOf(ref);
  const marks = marksOf(this) ?? {};
  setMarks(this, { ...marks, within: Object.freeze([...(marks.within ?? []), refs]) });
  return this;
}

function withAccess(this: QueryBuilder, permissions: readonly Permission[], opts?: WithAccessOptions): QueryBuilder {
  const what = '.withAccess()';
  requireResource(this, what);
  requireOwnQuery(this, what);
  if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every((p) => isPermission(p))) throw new AuthzConfigError(`${what}: needs a non-empty list of permission names`);
  const marks = marksOf(this) ?? {};
  setMarks(this, { ...marks, withAccess: Object.freeze([...new Set(permissions)]), ...envOf(opts, what) });
  return this;
}

function withFields(this: QueryBuilder, permission: Permission, opts?: WithAccessOptions): QueryBuilder {
  const what = `.withFields(${JSON.stringify(permission)})`;
  requireResource(this, what);
  requireOwnQuery(this, what);
  if (!isPermission(permission)) throw new AuthzConfigError(`${what}: not a permission name`);
  setMarks(this, { ...(marksOf(this) ?? {}), withFields: permission, ...envOf(opts, what) });
  return this;
}

// One methods object for the three builders; the extension bases are per builder.
const authzMethods: QueryExtension['methods'] = { accessible, unscoped, within };

/** `.accessible()`, `.unscoped()` and `.within()` on select builders; marks follow a clone. */
@Injectable(SelectQueryExtension)
export class AuthzSelectExtension extends SelectQueryExtension {
  public readonly name = 'authz-orm';
  public readonly methods = authzMethods;

  // A clone is the same query: it keeps what the caller declared (clone() runs no middleware).
  public onClone(source: QueryBuilder, clone: QueryBuilder): void {
    const marks = marksOf(source);
    if (marks !== undefined) setMarks(clone, marks);
  }
}

/** `.accessible()`, `.unscoped()` and `.within()` on update builders. */
@Injectable(UpdateQueryExtension)
export class AuthzUpdateExtension extends UpdateQueryExtension {
  public readonly name = 'authz-orm';
  public readonly methods = authzMethods;
}

/** `.accessible()`, `.unscoped()` and `.within()` on delete builders. */
@Injectable(DeleteQueryExtension)
export class AuthzDeleteExtension extends DeleteQueryExtension {
  public readonly name = 'authz-orm';
  public readonly methods = authzMethods;
}

/** `.withAccess()` and `.withFields()`, select builders only. */
@Injectable(SelectQueryExtension)
export class AuthzAccessFieldsExtension extends SelectQueryExtension {
  public readonly name = 'authz-orm:withAccess';
  public readonly methods: QueryExtension['methods'] = { withAccess, withFields };
}
