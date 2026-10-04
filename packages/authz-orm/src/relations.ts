import { AuthzConfigError, GLOBAL, RelationResolver, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { Principal, ResourceRef, ResourceType } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { ModelBase, extractModelDescriptor } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import type { OrmScopePolicy } from './api.js';
import { columnOf, dialectOf, idMode, idText } from './columns.js';
import { classesOf, entryOf, registeredTypes, scopePolicyOf, scopeRelationsOf } from './registry.js';
import { assertSynchronous } from './compile/sync.js';
import { findRow, pkOf } from './rows.js';
import type { Row } from './rows.js';

/** The subject when it is the row of `ref`, else that row loaded unscoped; null when there is none. */
async function rowFor(type: ResourceType, ref: ResourceRef, subject: unknown): Promise<Row | null> {
  if (subject instanceof ModelBase && entryOf(subject.constructor)?.type === type && ref.id !== undefined && ref.id !== null) {
    const pk = pkOf(subject.constructor as typeof ModelBase);
    const column = columnOf(subject.constructor, pk);
    if (column && idText(idMode(column, dialectOf(extractModelDescriptor(subject.constructor as never))), (subject as Row)[pk]) === String(ref.id)) return subject as Row;
  }
  return findRow(ref);
}

/** Conventions §4: a user whose id is the owner value, compared by the column's id mode as the SQL form does. */
export function ownsRow(principal: Principal, row: Row): boolean {
  if (principal?.type !== 'user' || typeof principal.id !== 'string') return false;
  const property = entryOf(row.constructor)?.owner;
  if (property === undefined) return false;
  const column = columnOf(row.constructor, property);
  if (!column) throw new AuthzConfigError(`authz-orm: @Owner() of ${row.constructor.name} is on '${property}', which is not a column of its table`);
  return idText(idMode(column, dialectOf(extractModelDescriptor(row.constructor as never))), row[property]) === principal.id;
}

class OwnerRelation extends RelationResolver {
  readonly relation = 'owner';

  constructor(readonly type: ResourceType) {
    super();
  }

  async holds(principal: Principal, ref: ResourceRef, subject?: unknown): Promise<boolean> {
    const row = await rowFor(this.type, ref, subject);
    return row !== null && ownsRow(principal, row);
  }
}

class ScopeRelation extends RelationResolver {
  constructor(readonly type: ResourceType, readonly relation: string) {
    super();
  }

  async holds(principal: Principal, ref: ResourceRef, subject?: unknown): Promise<boolean> {
    const row = await rowFor(this.type, ref, subject);
    if (row === null) return false;
    const cls = scopePolicyOf(row.constructor, this.relation);
    if (cls === undefined) return false;
    const policy = (await DI.resolve(cls as never)) as OrmScopePolicy;
    if (typeof policy.holds === 'function') return (await policy.holds(principal, row)) === true;
    return scopedExists(policy, principal, row);
  }
}

// Run as SYSTEM so the query middleware adds nothing; the policy's where, in its own group so an
// orWhere in it cannot reach past the pk, is the whole test.
async function scopedExists(policy: OrmScopePolicy, principal: Principal, row: Row): Promise<boolean> {
  const model = row.constructor as typeof ModelBase;
  const pk = pkOf(model);
  const id = row[pk];
  if (id === undefined || id === null) return false;
  const query = () =>
    model
      .where(pk, id)
      .where(function (this: IWhereBuilder<ModelBase>) {
        assertSynchronous(policy.scope(this, principal, 'read'), `the @OrmScope policy ${policy.constructor.name}.scope`);
      })
      .first() as Promise<unknown>;
  return (await runWithPrincipal(SYSTEM, query)) instanceof ModelBase;
}

/** One owner resolver per type that has an `@Owner` class, one resolver per `@OrmScope` relation of a type. */
export function ormRelations(): readonly RelationResolver[] {
  const out: RelationResolver[] = [];
  for (const type of registeredTypes()) {
    const classes = classesOf(type);
    if (classes.some((c) => entryOf(c)?.owner !== undefined)) out.push(new OwnerRelation(type));
    for (const relation of new Set(classes.flatMap((c) => scopeRelationsOf(c)))) out.push(new ScopeRelation(type, relation));
  }
  return out;
}

class FnRelation<T> extends RelationResolver {
  constructor(readonly type: ResourceType, readonly relation: string, private readonly fn: (p: Principal, row: T) => boolean) {
    super();
  }

  async holds(principal: Principal, ref: ResourceRef, subject?: unknown): Promise<boolean> {
    const row = await rowFor(this.type, ref, subject);
    if (row === null) return false;
    return this.fn(principal, row as unknown as T) === true;
  }
}

export function ownsBy<T>(type: ResourceType, relation: string, fn: (p: Principal, row: T) => boolean): RelationResolver {
  if (typeof type !== 'string' || type.length === 0 || type === GLOBAL.type) throw new AuthzConfigError(`ownsBy: the type must be a resource type, got ${JSON.stringify(type)}`);
  if (typeof relation !== 'string' || relation.length === 0) throw new AuthzConfigError(`ownsBy('${type}'): the relation must be a non-empty string`);
  if (typeof fn !== 'function') throw new AuthzConfigError(`ownsBy('${type}', '${relation}'): fn must be a function`);
  return new FnRelation(type, relation, fn);
}
