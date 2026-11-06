import type { RawQuery } from './builders/raw.js';
import type { ModelBase } from './model.js';
import type { Relation, SingleRelation } from './relation-objects.js';
import type { Wrap } from './statements.js';
import type { ExcludedModelProperties } from './types.js';

/**
 * Compile-time switches of the query builder. A package opts into strict column checking with
 * `declare module '@spinajs/orm' { interface OrmTypeRegistry { strictColumns: true } }`.
 */
export interface OrmTypeRegistry {
  // Keeps the interface non-empty (no-empty-object-type); never set.
  readonly __registry?: never;
}

export type OrmStrict = OrmTypeRegistry extends { strictColumns: true } ? true : false;

declare const columnLiteral: unique symbol;

/** A column name the type system cannot see (computed, unmanaged, from a joined table); made by {@link col}. */
export type ColumnLiteral = string & { readonly [columnLiteral]: true };

type RelationLike = Relation<any, any, any> | SingleRelation<any, any>;
type ColumnPropertyNames<T> = { [K in keyof T]-?: NonNullable<T[K]> extends ((...args: any[]) => any) | RelationLike ? never : K }[keyof T];
type RelationPropertyNames<T> = { [K in keyof T]-?: NonNullable<T[K]> extends RelationLike ? K : never }[keyof T];
type DeclaredColumns<M> = Exclude<Extract<ColumnPropertyNames<M>, string>, keyof ModelBase | ExcludedModelProperties>;

// `unknown extends M` holds for `any` and `unknown`; a model that declares no column (DB-first, or the
// ModelBase default of join callbacks) has nothing to check either. Both keep accepting any name.
export type ColumnName<M> = unknown extends M ? string : [DeclaredColumns<M>] extends [never] ? string : DeclaredColumns<M>;
export type RelationName<M> = unknown extends M ? string : Exclude<Extract<RelationPropertyNames<M>, string>, keyof ModelBase | ExcludedModelProperties>;
export type QualifiedColumn = `${string}.${string}`;

type Loose = OrmStrict extends true ? never : string & {};

/** A column where the builder takes only a name. */
export type ColumnRef<M> = ColumnName<M> | QualifiedColumn | ColumnLiteral | Loose;
export type ColumnArg<M> = ColumnRef<M> | RawQuery | Wrap;
/** `where('Owner', user)` compares the relation's foreign key. */
export type WhereColumn<M> = ColumnRef<M> | RelationName<M>;

// luxon columns also take a JS Date; the DateTime converter handles both.
type FieldValue<V> = V extends { toJSDate(): Date } ? V | Date : V;
type ValueAt<M, C> = C extends keyof M ? FieldValue<NonNullable<M[C]>> : unknown;
export type ColumnValue<M, C> = C extends ColumnName<M> ? ValueAt<M, C> | ValueAt<M, C>[] | RawQuery | null : unknown;

// In strict mode a column name must go through a typed overload, so its value is checked.
export type WhereCatchAllColumn<M> = OrmStrict extends true ? never : WhereColumn<M>;
export type WhereValue<M, C> = OrmStrict extends true ? ColumnValue<M, C> : any;
export type WhereOperator<O> = OrmStrict extends true ? O : any;

/** Escape hatch for a column the model does not declare; it is passed through unchecked. */
export function col(name: string): ColumnLiteral {
  return name as ColumnLiteral;
}
