import type { RawQuery } from './builders/raw.js';
import type { ISelectQueryBuilder } from './interfaces.js';
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
declare const projectedFrom: unique symbol;

/** Phantom marker of a row narrowed by `select`/`columns`/aggregates; `S` is the model it was taken from. */
export interface Projected<S> {
  readonly [projectedFrom]?: S;
}

// A model without the marker infers `S` as unknown, which is not a projection.
type ProjectionSource<R> = R extends Projected<infer S> ? (unknown extends S ? never : S) : never;

/** The model a (possibly projected) row comes from. */
export type SourceRow<R> = [ProjectionSource<R>] extends [never] ? R : ProjectionSource<R>;

/** A column name the type system cannot see (computed, unmanaged, from a joined table); made by {@link col}. */
export type ColumnLiteral = string & { readonly [columnLiteral]: true };

type RelationLike = Relation<any, any, any> | SingleRelation<any, any>;
type ColumnPropertyNames<T> = { [K in keyof T]-?: NonNullable<T[K]> extends ((...args: any[]) => any) | RelationLike ? never : K }[keyof T];
type RelationPropertyNames<T> = { [K in keyof T]-?: NonNullable<T[K]> extends RelationLike ? K : never }[keyof T];
type DeclaredColumns<M> = Exclude<Extract<ColumnPropertyNames<M>, string>, keyof ModelBase | ExcludedModelProperties>;

// `unknown extends M` holds for `any` and `unknown`; a model that declares no column (DB-first, or the
// ModelBase default of join callbacks) has nothing to check either. Both keep accepting any name.
export type ColumnName<M> = unknown extends M ? string : [DeclaredColumns<SourceRow<M>>] extends [never] ? string : DeclaredColumns<SourceRow<M>>;
export type RelationName<M> = unknown extends M ? string : Exclude<Extract<RelationPropertyNames<SourceRow<M>>, string>, keyof ModelBase | ExcludedModelProperties>;
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
export type ColumnValue<M, C> = C extends ColumnName<M> ? ValueAt<SourceRow<M>, C> | ValueAt<SourceRow<M>, C>[] | RawQuery | null : unknown;

// In strict mode a column name must go through a typed overload, so its value is checked.
export type WhereCatchAllColumn<M> = OrmStrict extends true ? never : WhereColumn<M>;
export type WhereValue<M, C> = OrmStrict extends true ? ColumnValue<M, C> : any;
export type WhereOperator<O> = OrmStrict extends true ? O : any;

// An `any`/`unknown` result has no rows to narrow. Reboxing it would turn `any` into `R[] | R` and `unknown`
// into `R`, so `SelectQueryBuilder<any>` (class parameters) would stop relating to `ISelectQueryBuilder<unknown>`.
export type Rebox<T, R> = unknown extends T ? T : T extends Array<any> ? R[] : R;

/** Members of a builder beyond ISelectQueryBuilder itself - the model's query scopes. */
export type ScopesOf<B> = Omit<B, keyof ISelectQueryBuilder<any>>;
export type Narrowed<B, T, R> = ISelectQueryBuilder<Rebox<T, R>> & ScopesOf<B>;
export type StrictNarrowed<B, T, R> = OrmStrict extends true ? Narrowed<B, T, R> : B;

type ProjectionBase<M> = [ProjectionSource<M>] extends [never] ? Projected<M> : M;
/** Adds `Added` to the projection of `M` (`select` after `select` accumulates). */
export type Project<M, Added> = ProjectionBase<M> & Added;
/** Replaces the projection of `M` (`columns()` and `count()` reset the select list). */
export type Reproject<M, Added> = Projected<SourceRow<M>> & Added;
export type PickColumns<M, C> = Pick<SourceRow<M>, C & keyof SourceRow<M>>;
export type ColumnTypeOf<M, C> = C extends keyof SourceRow<M> ? SourceRow<M>[C] : unknown;

/** Escape hatch for a column the model does not declare; it is passed through unchecked. */
export function col(name: string): ColumnLiteral {
  return name as ColumnLiteral;
}
