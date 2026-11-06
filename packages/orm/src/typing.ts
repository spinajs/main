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
declare const relationLiteral: unique symbol;

/** A relation name computed at runtime; made by {@link rel}. */
export type RelationLiteral = string & { readonly [relationLiteral]: true };
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
/** StrictNarrowed for a projection under an alias; a non-literal alias names no known column, so the row stays. */
export type StrictAliasNarrowed<B, T, A extends string, R> = OrmStrict extends true ? (string extends A ? B : Narrowed<B, T, R>) : B;

/** `count`, `sum` and `avg` under an alias: postgres returns COUNT and SUM/AVG of exact numbers as strings, and no converter runs on an alias. */
export type AggregateValue = number | string;
/** `min`/`max` under an alias: no converter runs on it, so a date column comes back in the driver's raw form. */
export type MinMaxValue<M, C> = ColumnTypeOf<M, C> extends infer V ? (NonNullable<V> extends Date | { toJSDate(): Date } ? Date | string | number : V) : never;

type ProjectionBase<M> = [ProjectionSource<M>] extends [never] ? Projected<M> : M;
/** Adds `Added` to the projection of `M` (`select` after `select` accumulates). */
export type Project<M, Added> = ProjectionBase<M> & Added;
/** Replaces the projection of `M` (`columns()` and `count()` reset the select list). */
export type Reproject<M, Added> = Projected<SourceRow<M>> & Added;
export type PickColumns<M, C> = Pick<SourceRow<M>, C & keyof SourceRow<M>>;
export type ColumnTypeOf<M, C> = C extends keyof SourceRow<M> ? SourceRow<M>[C] : unknown;

export type PopulatePath<M> = RelationName<M> | `${RelationName<M>}.${string}`;
export type Head<P extends string> = P extends `${infer H}.${string}` ? H : P;
// The model guarantees the row of a required to-one relation; an optional one leaves `Value` undefined when it is missing.
export type Populated<R, Optional = false> = R extends SingleRelation<infer U, any> ? R & { Value: Optional extends true ? U | undefined : U; Populated: true } : R extends Relation<any, any, any> ? R & { Populated: true } : R;
export type RelationTarget<M, K> = K extends keyof SourceRow<M> ? (NonNullable<SourceRow<M>[K]> extends SingleRelation<infer U, any> ? U : NonNullable<SourceRow<M>[K]> extends Relation<infer U, any, any> ? U : unknown) : unknown;
// `populate('a.b')` narrows `a` only; deeper levels keep their declared type.
export type WithPopulated<M, P extends string> = unknown extends M ? M : M & { [K in Head<P> & keyof SourceRow<M>]-?: Populated<NonNullable<SourceRow<M>[K]>, IsOptional<SourceRow<M>, K>> };
type IsOptional<M, K extends keyof M> = Partial<Pick<M, K>> extends Pick<M, K> ? true : false;

/** A relation name the legacy populate forms accept: any string in loose mode, a known relation in strict mode. */
export type PopulateName<M> = OrmStrict extends true ? PopulatePath<M> | RelationLiteral : string;
/** The object form `populate({ Metadata: {} })`; in strict mode its keys must be relations. */
export type PopulateTree<M> = OrmStrict extends true ? { [K in RelationName<M>]?: unknown } : object;

/** Escape hatch for a relation name computed at runtime; it is passed through unchecked. */
export function rel(name: string): RelationLiteral {
  return name as RelationLiteral;
}

/** Escape hatch for a column the model does not declare; it is passed through unchecked. */
export function col(name: string): ColumnLiteral {
  return name as ColumnLiteral;
}
