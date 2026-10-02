import type { Decision, Permission, Principal, RelationResolver, ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { IWhereBuilder, InsertQueryBuilder, ModelBase, UpdateQueryBuilder } from '@spinajs/orm';

// Takes the arguments so the stubs keep the design's parameter names under noUnusedParameters.
function notImplemented(name: string, ..._args: unknown[]): Error {
  return new Error(`@spinajs/authz-orm: ${name} is not implemented yet`);
}

// default permissions: `${type}:read|create|update|delete`; several models may share one type (B21)
// attributes: scope-row columns exposed as scope attributes
export function AccessResource(type: ResourceType, opts?: { relationScope?: 'where' | 'join'; permissions?: { read?: Permission; create?: Permission; update?: Permission; delete?: Permission }; attributes?: readonly string[] }): ClassDecorator {
  throw notImplemented('AccessResource', type, opts);
}

// relation 'owner' on the model's type
export function Owner(): PropertyDecorator {
  throw notImplemented('Owner');
}

// ancestors + 'under' + native:rbac.assignment
export function ScopeColumn(column: string, scopeType: ResourceType): PropertyDecorator {
  throw notImplemented('ScopeColumn', column, scopeType);
}

export function OrmScope(model: Class<ModelBase>, relation: string): ClassDecorator {
  throw notImplemented('OrmScope', model, relation);
}

export abstract class OrmScopePolicy<T extends ModelBase = ModelBase> {
  abstract scope(query: IWhereBuilder<T>, principal: Principal, op: 'read' | 'update' | 'delete'): void;
  authorizeCreate?(query: InsertQueryBuilder, principal: Principal): void | Promise<void>; // stamp or throw
  authorizeUpdate?(query: UpdateQueryBuilder<T>, values: Record<string, unknown>, principal: Principal): void | Promise<void>;
  holds?(principal: Principal, row: T): boolean | Promise<boolean>; // default: scoped EXISTS by primary key
}

export function filterFields<T>(decision: Decision, data: T, mode: 'read' | 'write'): { data: Partial<T>; removed: string[] } {
  throw notImplemented('filterFields', decision, data, mode);
}

// for models a package does not own (JobModel, DbConfig)
export function registerAccessResource(model: Class<ModelBase>, type: ResourceType, opts?: Parameters<typeof AccessResource>[1]): void {
  throw notImplemented('registerAccessResource', model, type, opts);
}

// in-memory relation for rule classes
export function ownsBy<T>(type: ResourceType, relation: string, fn: (p: Principal, row: T) => boolean): RelationResolver {
  throw notImplemented('ownsBy', type, relation, fn);
}

// a model compiles its own native op
export abstract class OrmNativeCompiler {
  abstract readonly op: `native:${string}`;
  abstract compile(args: unknown, builder: IWhereBuilder<unknown>, model: Class<ModelBase>, principal: Principal): void;
}
