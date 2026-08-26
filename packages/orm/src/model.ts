import { ModelData, ModelDataWithRelationData, PartialArray, PickRelations } from './types.js';
import { SortOrder } from './enums.js';
import { MODEL_DESCTRIPTION_SYMBOL } from './symbols.js';
import { IModelDescriptor, RelationType, InsertBehaviour, IInsertResult, IOrderByBuilder, ISelectQueryBuilder, IWhereBuilder, QueryScope, IHistoricalModel, ModelToSqlConverter, ObjectToSqlConverter, IModelBase, IColumnDescriptor, IRelationDescriptor, ServerResponseMapper, IDehydrateOptions, DbServerResponse, ISupportedFeature, ISaveOptions, ISaveResult } from './interfaces.js';
import { WhereFunction } from './types.js';
import { RawQuery, UpdateQueryBuilder, TruncateTableQueryBuilder, SelectQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder, createQuery, _descriptor } from './builders.js';
import { Op } from './enums.js';
import type { Orm } from './orm.js';
import { ModelHydrator } from './hydrators.js';
import { OrmException } from './exceptions.js';
import { StandardModelDehydrator, StandardModelWithRelationsDehydrator } from './dehydrators.js';
import { Wrap } from './statements.js';
import { OrmDriver } from './driver.js';
import { Relation, SingleRelation } from './relation-objects.js';
import { baselineValue, createSnapshot, IModelChange, IModelSnapshot, snapshotEquals, snapshotValue } from './snapshot.js';
import { UnitOfWork } from './unit-of-work.js';

import { DI, isConstructor, IContainer, Constructor, isClass, getInheritedDescriptor } from '@spinajs/di';

import { DateTime } from 'luxon';
import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { extractModelDescriptor, createDefaultModelDescriptor } from './descriptor.js';
import { assertAssignedKeys, generateClientSideKeys, hasPk, isCompositePk, orderByPk, pkColumns, pkGeneration, pkValueOf, setPkValue, whereAnyPk, wherePk } from './primary-keys.js';

/**
 *
 * Updates model descriptor
 *
 * @param targetOrForward
 * @param descriptor
 * @returns
 */
export function updateModelDescriptor(targetOrForward: any, callback: (descriptor: IModelDescriptor) => void): void {
  const target = !isConstructor(targetOrForward) && targetOrForward ? targetOrForward() : targetOrForward;

  if (!target) {
    return;
  }

  // Must go through getInheritedDescriptor like every other write of this
  // symbol - it hands back the class's OWN descriptor, so mutating it here
  // cannot leak into the base class ( eg. assigning the driver to a subclass )
  const descriptor = getInheritedDescriptor<IModelDescriptor>(target, MODEL_DESCTRIPTION_SYMBOL, createDefaultModelDescriptor);

  // Name is this class's own, never inherited from the base. Matters when this
  // is the FIRST access for the class: the descriptor is created by collapsing
  // the chain, and the merger keeps the ancestor's non-empty Name over the
  // default '' ( eg. a subclass would be stored under its parent's name )
  descriptor.Name = target.name;

  callback(descriptor);
}

export class ModelBase<M = unknown> implements IModelBase {
  private _container: IContainer;

  /**
   * Diff baseline: a value copy of every persisted column, taken when the row was last read
   * from or written to the database. `null` means the row has never been in the database, which
   * is what classifies it as an INSERT - not the presence of a primary key, because
   * `setDefaults()` pre-fills @Uuid keys on construction. Written only by `takeSnapshot()` and
   * `clearSnapshot()`.
   */
  private __snapshot__: IModelSnapshot | null = null;

  public static readonly _queryScopes: QueryScope;

  /**
   * Gets descriptor for this model. It contains information about relations, orm driver, connection properties,
   * db table attached, column information and others.
   */
  public get ModelDescriptor() {
    return extractModelDescriptor(this.constructor);
  }

  /**
   * Gets di container associated with this model ( via connection object  eg. different drivers have their own implementation of things)
   */
  public get Container() {
    if (!this._container) {
      const driver = DI.resolve<OrmDriver>('OrmConnection', [this.ModelDescriptor!.Connection!]);
      if (!driver) {
        throw new Error(`model ${this.constructor.name} have invalid connection ${this.ModelDescriptor!.Connection}, please check your db config file or model connection name`);
      }

      this._container = driver.Container;
    }

    return this._container;
  }

  /**
   * Primary key column names of this model. One element for the common single-column case.
   */
  public get PrimaryKeyName(): string[] {
    return this.ModelDescriptor!.PrimaryKey;
  }

  /**
   * Primary key value: a scalar for a single-column key, a tuple in key order for a composite key.
   */
  public get PrimaryKeyValue() {
    return pkValueOf(this, this.ModelDescriptor!);
  }

  /**
   * Accepts a scalar for a single-column key, and an array in key order or an object keyed by
   * column name for a composite key. Cascades the new value into loaded relations exactly as
   * before, using the single-column relation key ( relations join on one column pair ).
   */
  public set PrimaryKeyValue(newVal: any) {
    setPkValue(this, this.ModelDescriptor!, newVal);

    this.ModelDescriptor!.Relations.forEach((r) => {
      const rel = (this as any)[r.Name];
      if (!rel) return;

      // A relation's ForeignKey names ONE column, so it can only carry a single-column key.
      // Cascading a composite parent key into children is not expressible and is skipped.
      if (isCompositePk(this.ModelDescriptor!)) {
        return;
      }

      const scalar = pkValueOf(this, this.ModelDescriptor!);

      switch (r.Type) {
        case RelationType.One:
          (rel as any)[r.ForeignKey] = scalar;
          break;
        case RelationType.Many:
          (rel as any[]).forEach((rVal) => (rVal[r.ForeignKey] = scalar));
          break;
        case RelationType.ManyToMany:
          // TODO: rethink this
          break;
      }
    });
  }

  /**
   * The diff baseline for this instance, or `null` when it has never been hydrated from
   * the database. Read-only from the outside: mutate it only through `takeSnapshot()`,
   * `snapshotRelation()` and `clearSnapshot()`.
   */
  public get Snapshot(): IModelSnapshot | null {
    return this.__snapshot__;
  }

  /**
   * The columns the diff baseline covers: the real, persisted ones.
   *
   * `Virtual` columns are excluded, which is what every other value-handling path already does —
   * `StandardModelToSqlConverter` ( converters.ts ) drops them from every INSERT/UPDATE payload,
   * and the builders skip them when resolving a column statement. A virtual column has no database
   * column behind it, so a baseline for one can never produce a write; snapshotting it is pure cost.
   *
   * It is also the difference between working and throwing. `@Filterable` ( orm-http ) mints a
   * `{ Virtual: true }` column descriptor for ANY decorated property that has no column of its own,
   * RELATION properties included — the documented way to declare `exists` / `n-exists` filters.
   * Reading such a "column" off the model returns a `Relation`, not a column value, and a Many
   * relation is an `Array` subclass, so `snapshotValue` used to hand it to `_.cloneDeep`, which
   * rebuilds an array subclass with `new value.constructor()` and no arguments. The `Relation`
   * constructor then dereferences an undefined descriptor and every SELECT that hydrates the model
   * dies. A relation's baseline is `snapshotRelation()`'s job, and it stores primary keys.
   */
  private snapshotColumns(): IColumnDescriptor[] {
    return (this.ModelDescriptor?.Columns ?? []).filter((c) => !c.Virtual);
  }

  /**
   * The value this model writes for every foreign key a @BelongsTo currently manages, keyed by
   * column name. A relation holding a target owns its foreign key: `toSql()` writes the target's
   * join-column value ( `Relation.PrimaryKey` — the target's primary key unless `@BelongsTo`
   * names another column ), so a direct write to the column never reaches the database. A
   * relation holding null or undefined owns nothing and is absent here, leaving the column to
   * speak for itself: NULL after a `detach()`, untouched after a `populate()` that found no row.
   *
   * A @Recursive relation is excluded whatever it holds: `toSql()` writes its foreign key from
   * the raw column, overriding the relation, so the column is what reaches the database.
   *
   * The single place that answers "what does this model persist for this column", so the
   * snapshot baseline and the diff can never read the question differently.
   */
  private effectiveForeignKeys(): Map<string, unknown> {
    const effective = new Map<string, unknown>();

    for (const [, r] of this.ModelDescriptor?.Relations ?? []) {
      if (r.Type !== RelationType.One || !r.ForeignKey || r.Recursive) {
        continue;
      }

      const rel = (this as any)[r.Name];
      if (rel?.Value) {
        effective.set(r.ForeignKey, rel.Value[r.PrimaryKey]);
      }
    }

    return effective;
  }

  /**
   * Captures the current value of every column as the diff baseline, discarding any
   * previous baseline and any relation keys recorded against it.
   *
   * Reads the raw columns, deliberately: a snapshot is taken after an INSERT too, and an INSERT
   * may omit a foreign key on purpose ( a deferred self-reference, whose target had no key yet ).
   * Recording what the relation now holds would claim that key had been written and suppress the
   * follow-up UPDATE that actually writes it. `writeBackRelationKeys()` is what brings a column
   * in line with its relation, and it runs only where the key really was written.
   *
   * Values are copied, never aliased — see `snapshotValue`. An aliased snapshot makes
   * every diff empty and `save()` a silent no-op.
   */
  public takeSnapshot(): void {
    const snapshot = createSnapshot();

    for (const c of this.snapshotColumns()) {
      snapshot.Columns.set(c.Name, snapshotValue((this as any)[c.Name], c.Converter));
    }

    this.__snapshot__ = snapshot;
  }

  /**
   * Copies the value each @BelongsTo relation just wrote back onto its foreign-key column, so
   * the model agrees with the row. Call it after a statement that wrote those keys, before
   * `takeSnapshot()`.
   *
   * Without it a foreign key written directly and then overridden by its relation keeps the
   * overridden value in the column, the snapshot records that value as the baseline, and the
   * model reads dirty forever - every `save()` minting an UPDATE that changes nothing.
   */
  private writeBackRelationKeys(): void {
    for (const [name, value] of this.effectiveForeignKeys()) {
      (this as any)[name] = value;
    }
  }

  /**
   * Records the primary keys of the members currently in relation `name` as that
   * relation's baseline. A no-op when the model has no snapshot — an unhydrated model
   * has nothing to diff against and its relations are all "new".
   *
   * @param name - relation property name, as declared on the model descriptor
   */
  public snapshotRelation(name: string): void {
    if (!this.__snapshot__) {
      return;
    }

    const relation = (this as any)[name];

    if (relation === null || relation === undefined) {
      return;
    }

    if (relation instanceof SingleRelation) {
      const value = relation.Value;
      this.__snapshot__.Relations.set(name, value ? [value.PrimaryKeyValue] : []);
      return;
    }

    if (typeof relation[Symbol.iterator] === 'function') {
      this.__snapshot__.Relations.set(
        name,
        [...(relation as Iterable<ModelBase>)].map((m) => m.PrimaryKeyValue),
      );
    }
  }

  /**
   * Discards the diff baseline. After this the model is treated as brand new by `save()`.
   */
  public clearSnapshot(): void {
    this.__snapshot__ = null;
  }

  /**
   * `true` until the row has been in the database: the diff baseline is `null`. This is what
   * classifies the model as an INSERT - not the presence of a primary key, because
   * `setDefaults()` pre-fills @Uuid keys on construction.
   */
  public get IsNew(): boolean {
    return this.__snapshot__ === null;
  }

  /**
   * Whether `save()` would write anything: a model that has never been in the database, or one
   * with at least one column ( or re-pointed foreign key ) differing from its baseline.
   *
   * Derived from the snapshot on every read - there is no write observer - so it costs one
   * comparison per column until the first difference. There is deliberately no setter: the only
   * way to make a model clean is to persist it or to re-baseline it with `takeSnapshot()`.
   */
  public get IsDirty(): boolean {
    return this.IsNew || this.diff(true).length > 0;
  }

  /**
   * Every persisted column whose current value differs from the baseline, in descriptor column
   * order, followed by any @BelongsTo foreign key the descriptor declares no column for. On a
   * model with no baseline every column is reported with `OldValue: undefined`.
   *
   * Computed on demand - nothing observes writes - so an in-place mutation of a JSON column is
   * seen exactly like an assignment. Call it once and reuse the result rather than polling it
   * in a loop.
   *
   * Named `changeSet` - not `changes` - because model members and columns share a namespace and
   * `changes` is a real column name in downstream schemas.
   */
  public changeSet(): IModelChange[] {
    return this.diff(false);
  }

  /**
   * The single diff. `stopAtFirst` lets a boolean question return as soon as one change is found.
   *
   * Every foreign key is resolved to ONE effective value before anything is compared, so
   * `IsDirty` and `changeSet()` can never disagree and the short-circuit can never skip a
   * decision the full diff would have made.
   *
   * The rule: a @BelongsTo holding a target decides its foreign key, because that is what
   * `toSql()` writes - the target's join-column value, `Relation.PrimaryKey`, which is the
   * target's own primary key unless `@BelongsTo` names another column. A direct write to the
   * column is therefore overridden and never reaches the database, and the diff has to say so.
   * A relation holding null or undefined decides nothing and the column stands: NULL after a
   * `detach()`, untouched after a `populate()` that found no row.
   */
  private diff(stopAtFirst: boolean): IModelChange[] {
    const columns = this.snapshotColumns();
    const snap = this.__snapshot__?.Columns;
    const out: IModelChange[] = [];

    const effective = this.effectiveForeignKeys();

    for (const c of columns) {
      const current = effective.has(c.Name) ? effective.get(c.Name) : (this as any)[c.Name];
      if (!snap || !snapshotEquals(snap.get(c.Name), current, c.Converter)) {
        out.push({ Column: c.Name, OldValue: baselineValue(snap?.get(c.Name)), NewValue: current });
        if (stopAtFirst) {
          return out;
        }
      }
    }

    // A relation-managed foreign key the descriptor has no column for - the loop above never
    // saw it, and there is no converter to compare it through.
    const declared = new Set(columns.map((c) => c.Name));
    for (const [name, current] of effective) {
      if (declared.has(name)) {
        continue;
      }

      if (!snap || !snapshotEquals(snap.get(name), current)) {
        out.push({ Column: name, OldValue: baselineValue(snap?.get(name)), NewValue: current });
        if (stopAtFirst) {
          return out;
        }
      }
    }

    return out;
  }

  public valueOf() {
    return this.PrimaryKeyValue;
  }

  public driver(): OrmDriver {
    const orm = DI.get<Orm>('Orm')!;
    const driver = orm.Connections.get(this.ModelDescriptor!.Connection!);
    return driver!;
  }

  /**
   * Recursivelly takes all relation data and returns as single array
   */
  public getFlattenRelationModels(recursive?: boolean): ModelBase[] {
    const reduceRelations = function (m: ModelBase): ModelBase[] {
      const relations = [...m.ModelDescriptor!.Relations.values()];
      const models = _.flatMap(relations, (r) => {
        if (r.Type === RelationType.Many || r.Type === RelationType.ManyToMany) {
          return (m as any)[r.Name];
        }

        if (((m as any)[r.Name] as SingleRelation<any>).Value) {
          return [(m as any)[r.Name].Value];
        }
      }).filter((x) => x !== undefined);

      if (recursive) {
        return [...models, ..._.flatMap(models, reduceRelations)];
      }

      return models;
    };

    return reduceRelations(this);
  }

  public static getModelDescriptor(): IModelDescriptor {
    throw new Error('Not implemented');
  }

  public static getRelationDescriptor(_relation: string): IRelationDescriptor {
    throw new Error('Not implemented');
  }

  /**
   * Clears all data in table
   */
  public static truncate() {
    throw new Error('Not implemented');
  }

  /**
   * Get all data from db
   */
  public static all<T extends typeof ModelBase>(this: T, _page?: number, _perPage?: number): SelectQueryBuilder<Array<InstanceType<T>>> {
    throw new Error('Not implemented');
  }

  /**
   * Inserts data to DB.
   *
   * @param _data - data to insert
   */
  public static insert<T extends typeof ModelBase>(this: T, _data: InstanceType<T> | Partial<InstanceType<T>> | PickRelations<T> | Array<InstanceType<T>> | Array<Partial<InstanceType<T>>>, _insertBehaviour: InsertBehaviour = InsertBehaviour.None): InsertQueryBuilder {
    throw new Error('Not implemented');
  }

  /**
   * Search entities in db
   *
   * @param column - column to search or function
   * @param operator - boolean operator
   * @param value - value to compare
   */
  public static where<T extends typeof ModelBase>(this: T, val: boolean): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'];
  public static where<T extends typeof ModelBase>(this: T, val: PartialArray<InstanceType<T>> | PickRelations<T>): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'];
  public static where<T extends typeof ModelBase>(this: T, func: WhereFunction<InstanceType<T>>): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'];
  public static where<T extends typeof ModelBase>(this: T, column: string, operator: Op, value: any): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'];
  public static where<T extends typeof ModelBase>(this: T, column: string, value: any): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'];
  public static where<T extends typeof ModelBase>(this: T, statement: Wrap): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'];
  public static where<T extends typeof ModelBase>(this: T, column: string | boolean | WhereFunction<InstanceType<T>> | RawQuery | PartialArray<InstanceType<T>> | Wrap | PickRelations<T>, operator?: Op | any, value?: any): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'];
  public static where<T extends typeof ModelBase>(this: T, _column: string | boolean | WhereFunction<InstanceType<T>> | RawQuery | PartialArray<InstanceType<T>> | Wrap | PickRelations<T>, _operator?: Op | any, _value?: any): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'] {
    throw new Error('Not implemented');
  }

  /**
   * Updates single or multiple records at once with provided value based on condition
   *
   * @param _data - data to set
   */
  public static update<T extends typeof ModelBase>(this: T, _data: Partial<InstanceType<T>>): UpdateQueryBuilder<InstanceType<T>> & T['_queryScopes'] {
    throw new Error('Not implemented');
  }

  /**
   * Tries to find all models with given primary keys
   */
  public static find<T extends typeof ModelBase>(this: T, _pks: any[]): Promise<Array<InstanceType<T>>> {
    throw new Error('Not implemented');
  }

  /**
   * Tries to get first result from db
   *
   * Orders by Primary key, if pk not exists then by unique constraints and lastly by CreateAt if no unique columns exists.
   */
  public static first<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T> & T['_queryScopes']) => void): Promise<InstanceType<T>>;
  public static first<T extends typeof ModelBase>(this: T): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Tries to get first result from db
   *
   * Orders by Primary key, if pk not exists then by unique constraints and lastly by CreateAt if no unique columns exists.
   */
  public static last<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T> & T['_queryScopes']) => void): Promise<InstanceType<T>>;
  public static last<T extends typeof ModelBase>(this: T): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Tries to get newest result from db. It throws if model dont have CreatedAt decorated property
   */
  public static newest<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T> & T['_queryScopes']) => void): Promise<InstanceType<T>>;
  public static newest<T extends typeof ModelBase>(this: T): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Tries to get oldest result from db. It throws if model dont have CreatedAt decorated property
   */
  public static oldest<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T> & T['_queryScopes']) => void): Promise<InstanceType<T>>;
  public static oldest<T extends typeof ModelBase>(this: T): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Returns total count of entries in db for this model
   */
  public static count<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T> & T['_queryScopes']) => void): Promise<number>;
  public static count<T extends typeof ModelBase>(this: T): Promise<number> {
    throw new Error('Not implemented');
  }

  /**
   * Tries to find all models in db. If not all exists, throws exception
   */
  public static findOrFail<T extends typeof ModelBase>(this: T, _pks: any[]): Promise<Array<InstanceType<T>>> {
    throw new Error('Not implemented');
  }

  /**
   * gets model by specified pk, if not exists, returns null
   *
   */
  public static get<T extends typeof ModelBase>(this: T, _pk: any): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Finds model by specified pk. If model not exists in db throws exception
   *
   */
  public static getOrFail<T extends typeof ModelBase>(this: T, _pk: any): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   *
   * Checks if model with pk key or unique fields exists and if not creates one AND NOT save in db
   * NOTE: it checks for unique fields constraint
   */
  public static getOrNew<T extends typeof ModelBase>(this: T, _data?: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Creates query on this model. used for quering db for partial data, to perform some kind of operations
   * that dont need full ORM model to involve, or other non standard operations eg. joins or raw data queries based on this model
   */
  public static query<T extends typeof ModelBase>(this: T): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'] {
    throw new Error('Not implemented');
  }

  /**
   * Populates relation data. It returns query builder that can be used to fetch data from db
   *
   * @param _relation - relation name
   * @param _owner - owner model
   */
  public static populate<R extends typeof ModelBase>(_relation: string, _owner: ModelBase | number | string): ISelectQueryBuilder<Array<InstanceType<R>>> & R['_queryScopes'] {
    throw new Error('Not implemented');
  }

  /**
   * Selects data from db. It returns query builder that can be used to fetch data from db
   *
   */
  public static select<T extends typeof ModelBase>(this: T): ISelectQueryBuilder<Array<InstanceType<T>>> & T['_queryScopes'] {
    throw new Error('Method not implemented.');
  }

  /**
   *
   * Checks if model with pk key / unique fields exists and if not creates one and saves to db
   * NOTE: it checks for unique fields too.
   *
   * @param data - model width data to check
   */
  public static getOrCreate<T extends typeof ModelBase>(this: T, _pk: string | number | null, _data?: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Creates new model & saves is to db
   *
   * @param  data - initial model data
   */
  public static create<T extends typeof ModelBase>(this: T, _data: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Deletes model from db
   *
   * @param pk - primary key
   */

  public static destroy<T extends typeof ModelBase>(this: T, _pk?: any | any[]): DeleteQueryBuilder<InstanceType<T>> & T['_queryScopes'] {
    throw new Error('Not implemented');
  }

  /**
   * Checks if model exists in db
   */
  public static exists(): Promise<boolean> {
    throw new Error('Not implemented');
  }

  public static whereExists<R extends typeof ModelBase, T extends typeof ModelBase>(this: T, _qOrR: string | ISelectQueryBuilder<T>, _func?: WhereFunction<InstanceType<R>>): ISelectQueryBuilder<Array<InstanceType<T>>> {
    throw new Error('Not implemented');
  }

  public static whereNotExists<R extends typeof ModelBase, T extends typeof ModelBase>(this: T, _qOrR: string | ISelectQueryBuilder<T>, _func?: WhereFunction<InstanceType<R>>): ISelectQueryBuilder<Array<InstanceType<T>>> {
    throw new Error('Not implemented');
  }

  /**
   * Runs `_callback` inside a transaction on this model's connection. The transaction commits
   * when the callback resolves and rolls back when it throws — see `OrmDriver.transaction`.
   * Resolves with whatever the callback returned.
   */
  public static transaction<T extends typeof ModelBase, R>(this: T, _callback: (trx: OrmDriver) => Promise<R>): Promise<R> {
    throw new Error('Not implemented');
  }

  constructor(data?: Partial<M>) {
    this.setDefaults();

    if (data) {
      this.hydrate(data as any);
    }
  }

  /**
   * Fills model with data. It only fills properties that exists in database
   *
   * @param data - data to fill
   */
  public hydrate(data: Partial<this>) {
    this.Container.resolve(Array.ofType(ModelHydrator)).forEach((h) => h.hydrate(this, data));
  }

  /**
   *
   * Attachess model to proper relation an sets foreign key
   *
   * @param data - model to attach
   */
  public attach(data: ModelBase) {
    // TODO: refactor this, to not check every time for relation
    // do this as map or smth
    for (const [, v] of this.ModelDescriptor!.Relations.entries()) {
      // Constructor identity, not class name. Name matching pushed the row into *every*
      // relation whose target happened to share a name, so a model with two relations to
      // the same target received it twice ( B26 ), and it breaks under minification ( A9 ).
      if (v.TargetModel !== (data as any).constructor) {
        continue;
      }

      switch (v.Type) {
        case RelationType.One:
          ((this as any)[v.Name] as SingleRelation<ModelBase>).attach(data);
          break;

        case RelationType.Many: {
          // Set the child's back-reference to this owner, when the child declares one.
          const rel = [...data.ModelDescriptor!.Relations.entries()].find((e) => e[1].ForeignKey === v.ForeignKey);
          if (rel) {
            (data as any)[rel[0]].Value = this;
          }

          ((this as any)[v.Name] as Relation<ModelBase, ModelBase, typeof ModelBase>).push(data);
          break;
        }

        case RelationType.ManyToMany:
          // No back-reference: the link lives in the junction table, not on the target row.
          // The `push` is written out again rather than shared with the Many case above —
          // the two are only coincidentally similar, and the missing `break` that used to
          // join them was one reordering away from silently breaking.
          ((this as any)[v.Name] as Relation<ModelBase, ModelBase, typeof ModelBase>).push(data);
          break;

        default:
          break;
      }
    }
  }

  /**
   * Extracts all data from model. It takes only properties that exists in DB
   *
   * Properties declared with `@Hidden()` are always omitted - see `descriptor.Hidden`.
   */
  public dehydrate(options?: IDehydrateOptions): ModelData<this> {
    return this.Container.resolve(StandardModelDehydrator).dehydrate(this, {
      ...options,
      omit: [...(options?.omit ?? []), ...(this.ModelDescriptor?.Hidden ?? [])],
    }) as ModelData<this>;
  }

  /**
   *
   * Extracts all data from model with relation data. Relation data are dehydrated recursively.
   *
   * Properties declared with `@Hidden()` are always omitted, relations included.
   *
   * @param omit - fields to omit
   */
  dehydrateWithRelations(options?: IDehydrateOptions): ModelDataWithRelationData<this> {
    return this.Container.resolve(StandardModelWithRelationsDehydrator).dehydrate(this, {
      ...options,
      omit: [...(options?.omit ?? []), ...(this.ModelDescriptor?.Hidden ?? [])],
    }) as ModelDataWithRelationData<this>;
  }

  public toSql(onlyDirty?: boolean): Partial<this> {
    const vals = this.Container.resolve(ModelToSqlConverter).toSql(this) as Partial<this>;

    if (onlyDirty) {
      return _.pick(vals, this.changeSet().map((c) => c.Column));
    }

    return vals;
  }

  /**
   * deletes enitt from db. If model have SoftDelete decorator, model is marked as deleted
   */
  public async destroy() {
    // A composite key is a tuple, and a tuple is ALWAYS truthy - so the old `!pk` guard
    // would happily issue a DELETE for a model whose key columns are still unset.
    const pk = this.PrimaryKeyValue;
    const missing = Array.isArray(pk) ? pk.some((v) => v === null || v === undefined) : !pk;
    if (missing) {
      return;
    }

    const result = await (this.constructor as any).destroy(pk);

    return result;
  }

  /**
   * If model can be in achived state - sets archived at date and saves it to db
   */
  public async archive() {
    if (this.ModelDescriptor!.Archived) {
      (this as any)[this.ModelDescriptor!.Archived.ArchivedAt] = DateTime.now();
    } else {
      throw new OrmException('archived at column not exists in model');
    }

    const { query } = this.createUpdateQuery();
    query.update(this.toSql());
    wherePk(query, this.ModelDescriptor!, this.PrimaryKeyValue);

    const result = await query;

    // The whole model is in the database now - that is the baseline for the next update().
    this.writeBackRelationKeys();
    this.takeSnapshot();

    return result;
  }

  /**
   * Writes the columns that differ from the snapshot.
   *
   * The change set is `changeSet()` - the snapshot diff, which also covers a foreign key that was
   * re-pointed through its relation - so re-assigning a column its current value produces no
   * UPDATE, and a column written A -> B -> A is not written back.
   *
   * A model with no snapshot ( never hydrated ) reports every column as changed, which is the
   * right answer: there is no baseline to be more precise than.
   *
   * @param data - optional patch hydrated onto the model first
   */
  public async update(data?: Partial<this>) {
    const result = {
      RowsAffected: 0,
      LastInsertId: 0,
    };

    if (data) {
      this.hydrate(data);
    }

    const keyColumns = this.ModelDescriptor!.PrimaryKey ?? [];
    const changed = this.changeSet()
      .map((c) => c.Column)
      .filter((c) => !keyColumns.includes(c));

    // Nothing to write. Checked against the diff, so re-assigning a column its current value
    // no longer produces an UPDATE that sets it to what it already was.
    if (changed.length === 0) {
      return result;
    }

    const updatedAt = this.ModelDescriptor!.Timestamps.UpdatedAt;
    if (updatedAt) {
      (this as any)[updatedAt] = DateTime.now();
      if (!changed.includes(updatedAt)) {
        changed.push(updatedAt);
      }
    }

    const { query } = this.createUpdateQuery();
    query.update(_.pick(this.toSql() as Record<string, unknown>, changed));
    wherePk(query, this.ModelDescriptor!, this.PrimaryKeyValue);

    const updateResult = await query;

    this.writeBackRelationKeys();
    this.takeSnapshot();

    return updateResult;
  }

  /**
   * Save all changes to db. It creates new entry id db or updates existing one if
   * primary key exists
   */
  public async insert(insertBehaviour: InsertBehaviour = InsertBehaviour.None) {
    // Both run BEFORE the query is built, so an `assigned` key that was never supplied fails
    // without touching the database.
    generateClientSideKeys(this, this.ModelDescriptor!);
    assertAssignedKeys(this, this.ModelDescriptor!);

    const { query, description } = this.createInsertQuery();
    const sResponseMapper = query.Container.resolve(ServerResponseMapper);

    switch (insertBehaviour) {
      case InsertBehaviour.InsertOrIgnore:
        query.orIgnore();
        break;
      case InsertBehaviour.InsertOrUpdate:
        query.onDuplicate().update(description.Columns.filter((c) => !c.PrimaryKey).map((c) => c.Name));
        break;
      case InsertBehaviour.InsertOrReplace:
        query.orReplace();
        break;
    }

    // Only an `auto` key needs the database to tell us what it became. Asking for RETURNING
    // where the dialect supports it beats reading an identity counter, and is the shape
    // orm-uow needs to backfill cascaded children.
    const needsKeyBack = pkColumns(description).some((c) => pkGeneration(description, c) === 'auto');
    if (needsKeyBack && insertBehaviour !== InsertBehaviour.InsertOrUpdate && query.Driver.supportedFeatures().insertReturning) {
      query.returning(pkColumns(description));
    }

    query.middleware({
      afterQuery: (data: IInsertResult) => {
        const response = sResponseMapper.read(data, pkColumns(description));

        if ((response.Returning ?? []).length !== 0) {
          setPkValue(this, description, pkValueOf(response.Returning[0], description));
        } else if (needsKeyBack) {
          // Do not overwrite a key the caller already supplied ( uuid / assigned strategies ).
          // Same tuple-truthiness trap as destroy().
          const current = this.PrimaryKeyValue;
          const missing = Array.isArray(current) ? current.some((v) => v === null || v === undefined) : !current;
          if (missing) {
            this.PrimaryKeyValue = response.LastInsertId;
          }
        }

        return data;
      },
      modelCreation: (): any => null,
      afterHydration: (): any => null,
    });

    // Awaited here, not by the caller: the afterQuery middleware above backfills a generated key
    // during execution, and the snapshot must include it. Taken only after the await - a throw
    // leaves the model exactly as dirty as it was.
    const result = await query.values(this.toSql());

    this.writeBackRelationKeys();
    this.takeSnapshot();

    return result;
  }

  /**
   *
   * Shorthand for inserting model when no primary key exists, or update
   * its value in db if primary key is set
   *
   * @param insertBehaviour - insert mode
   */
  public async insertOrUpdate() {
    if (this.PrimaryKeyValue) {
      return await this.update();
    }
    return await this.insert();
  }

  /**
   * Persists this model and everything reachable from it in one transaction.
   *
   * The graph is diffed against the snapshots taken when it was loaded, sorted so that a
   * parent is inserted before any child that references it, and executed as inserts, then
   * updates restricted to the columns that actually changed, then junction rows, then the
   * orphan policy of every relation that lost a member.
   *
   * A relation that was never populated is invisible: `Items: OrderItem[] = []` on a freshly
   * constructed model deletes nothing. That is the deliberate divergence from TypeORM.
   *
   * @param options - `{ reload: true }` to diff against current database state instead of the
   *                  hydration snapshot; `{ chunk: n }` to bound batched statement size.
   */
  public async save(options?: ISaveOptions): Promise<ISaveResult> {
    // `UnitOfWork` is referenced only inside this body, never at module-evaluation time, so
    // the model.ts -> unit-of-work.ts -> ... -> model.ts cycle stays safe under ESM. Do not
    // move this into a field initializer or an extends clause.
    return await UnitOfWork.save(this, options);
  }

  /**
   * Gets model data from database and returns as fresh instance.
   *
   * If primary key is not fetched, tries to load by columns with unique constraint.
   * If there is no unique columns or primary key, throws error
   */
  public async fresh(): Promise<this> {
    const { query, description } = this.createSelectQuery();
    query.select('*');

    _preparePkWhere(description, query, this);
    _prepareOrderBy(description, query);

    // TODO: rethink all cast of this type?
    return (await query.firstOrFail()) as unknown as Promise<this>;
  }

  /**
   * Refresh model from database.
   *
   * If no primary key is set, tries to fetch data base on columns
   * with unique constraints. If none exists, throws exception
   */
  public async refresh(): Promise<void> {
    let model: this | null = null;

    model = await this.fresh();

    for (const c of this.ModelDescriptor!.Columns) {
      (this as any)[c.Name] = (model as any)[c.Name];
    }

    // Every column now holds what the database holds - that is the new baseline, not the one
    // captured before the refresh.
    this.takeSnapshot();
  }

  public toJSON() {
    return this.dehydrate();
  }

  /**
   * sets default values for model. values are taken from DB default column prop
   */
  protected setDefaults() {
    this.ModelDescriptor!.Columns?.forEach((c) => {
      if (c.Uuid) {
        (this as any)[c.Name] = uuidv4();
      } else {
        (this as any)[c.Name] = c.DefaultValue;
      }
    });

    // `uuid` primary keys are generated at construction so the value is available to callers
    // and to cascaded children before the row ever reaches the database.
    generateClientSideKeys(this, this.ModelDescriptor!);

    if (this.ModelDescriptor!.Timestamps.CreatedAt) {
      (this as any)[this.ModelDescriptor!.Timestamps.CreatedAt] = DateTime.now();
    }

    for (const [, rel] of this.ModelDescriptor!.Relations) {
      if (rel.Factory) {
        (this as any)[rel.Name] = rel.Factory(this, rel, this.Container, []);
      } else if (rel.RelationClass) {
        if (isClass(rel.RelationClass)) {
          (this as any)[rel.Name] = this.Container.resolve(rel.RelationClass, [this, rel, []]);

        } else if (_.isFunction(rel.RelationClass)) {
          (this as any)[rel.Name] = this.Container.resolve(rel.RelationClass(), [this, rel, []]);
        }
        else {
          throw new OrmException(`RelationClass for relation ${rel.Name} is not a class or a function returning class`);
        }
      } else {
        (this as any)[rel.Name] = new SingleRelation(this, rel.TargetModel, rel, undefined);
      }
    }
  }

  protected createSelectQuery() {
    return createQuery(this.constructor, SelectQueryBuilder);
  }

  protected createUpdateQuery() {
    return createQuery(this.constructor, UpdateQueryBuilder);
  }

  protected createInsertQuery() {
    return createQuery(this.constructor, InsertQueryBuilder);
  }
}


/**
 * Decides whether a multi-row insert's generated keys can be read off `LastInsertId + index` on a
 * dialect that has no RETURNING.
 *
 * The premise is a documented MySQL guarantee, not a guess. InnoDB splits inserts into *simple*
 * ones — row count known before execution, which is exactly what `INSERT INTO t (…) VALUES (…),
 * (…)` is, and the only shape {@link InsertQueryBuilder} can build — and *bulk* ones
 * (`INSERT … SELECT`), where it is not. For a simple insert InnoDB reserves one contiguous block
 * of N auto-increment values under a short mutex it releases immediately, so the k-th row of the
 * statement gets `LAST_INSERT_ID() + k`. This holds under `innodb_autoinc_lock_mode = 2`, the
 * MySQL 8 default, and was verified against a live server. The "values may not be contiguous"
 * caveat in the MySQL manual is about bulk inserts and about mixed-mode inserts.
 *
 * The guards below rule out every case where the mapping stops being positional.
 */
function _canBackfillContiguousKeys(description: IModelDescriptor, rows: any[], response: DbServerResponse, features: ISupportedFeature, insertBehaviour: InsertBehaviour): boolean {
  // Only a dialect whose reported id is the FIRST of the block can be walked forwards. MSSQL's
  // SCOPE_IDENTITY() and SQLite's last_insert_rowid() report the LAST one.
  if (!features.insertIdIsFirstOfBatch) {
    return false;
  }

  // One database-generated identity column, or there is no counter to walk. A composite key has
  // no single identity column, and uuid / assigned keys are already set by this point.
  const keys = pkColumns(description);
  if (keys.length !== 1 || pkGeneration(description, keys[0]) !== 'auto') {
    return false;
  }

  // INSERT IGNORE / REPLACE / ON DUPLICATE KEY UPDATE are mixed-mode: rows can be skipped,
  // replaced or updated rather than inserted, so the k-th allocated id stops belonging to the
  // k-th input row. ( The array path rejects these outright today; this keeps the invariant
  // local to the decision rather than depending on a check three hundred lines away. )
  if (insertBehaviour !== InsertBehaviour.None) {
    return false;
  }

  // No identity value reported at all.
  if (typeof response.LastInsertId !== 'number' || !Number.isFinite(response.LastInsertId) || response.LastInsertId <= 0) {
    return false;
  }

  // The server must confirm it inserted exactly one row per row we sent. Anything else means
  // rows were skipped or the statement did something other than a plain multi-row insert.
  if (response.RowsAffected !== rows.length) {
    return false;
  }

  // A batch where SOME rows carry an explicit key is a mixed-mode insert: InnoDB allocates
  // auto-increment values only for the rows that omitted one, so index arithmetic would both
  // mis-key the generated rows and overwrite the supplied ones.
  return rows.every((v) => v instanceof ModelBase && (v.PrimaryKeyValue === null || v.PrimaryKeyValue === undefined));
}

function _preparePkWhere(description: IModelDescriptor, query: ISelectQueryBuilder<any>, model: ModelBase) {
  // NOTE: `if (description.PrimaryKey)` used to be false for the '' default. An empty ARRAY is
  // truthy, so this must be an explicit length check or no-primary-key models would stop
  // falling back to their unique columns.
  if (hasPk(description)) {
    wherePk(query, description, model.PrimaryKeyValue);
  } else {
    const unique = description.Columns.filter((x) => x.Unique);
    if (unique.length !== 0) {
      for (const c of unique) {
        query.where(c.Name, '=', (model as any)[c.Name]);
      }
    } else {
      throw new OrmException('Model dont have primary key set or columns with unique constraint, cannot fetch model from database');
    }
  }
}

function _prepareOrderBy(description: IModelDescriptor, query: IOrderByBuilder, order?: SortOrder) {
  // orderByPk emits one ORDER BY term per key column and reports whether the model has a
  // primary key at all - see the note in _preparePkWhere on why a length check is required.
  if (orderByPk(query, description, order ?? SortOrder.DESC)) {
    return;
  }

  const unique = description.Columns.filter((c) => c.Unique);
  if (unique.length !== 0) {
    unique.forEach((c) => query.order(c.Name, order ?? SortOrder.DESC));
  } else if (description.Timestamps?.CreatedAt) {
    query.order(description.Timestamps.CreatedAt, order ?? SortOrder.DESC);
  } else if (description.Timestamps?.UpdatedAt) {
    query.order(description.Timestamps.UpdatedAt, order ?? SortOrder.DESC);
  }
}

export abstract class HistoricalModel implements IHistoricalModel {
  public readonly __action__: 'update' | 'insert' | 'delete';
  public readonly __revision__: number;
  public readonly __start__: DateTime;
  public readonly __end__: DateTime;
}


export const MODEL_STATIC_MIXINS = {
  getModelDescriptor(): IModelDescriptor {
    const dsc = _descriptor(this);

    if (!dsc) {
      throw new OrmException(`Model ${this.constructor.name} has no descriptor`);
    }

    return dsc;
  },

  getRelationDescriptor(relation: string): IRelationDescriptor {
    const descriptor = this.getModelDescriptor();
    let rDescriptor = null;
    for (const [key, value] of descriptor.Relations) {
      if (key.toLowerCase() === relation.toLowerCase().trim()) {
        rDescriptor = value;
        break;
      }
    }

    if (!rDescriptor) {
      throw new OrmException(`Model ${this.constructor.name} has no relation ${relation}`);
    }

    return rDescriptor;
  },

  truncate(): TruncateTableQueryBuilder {
    const { query } = createQuery(this, TruncateTableQueryBuilder, false);
    return query;
  },

  driver(): OrmDriver {
    const dsc = this.getModelDescriptor();
    const orm = DI.get<Orm>('Orm')!;
    const driver = orm.Connections.get(dsc.Connection!);

    if (!driver) {
      throw new Error(`model ${this.name} have invalid connection ${dsc.Connection}, please check your db config file or model connection name`);
    }

    return driver;
  },

  // Every branch now returns a builder or throws, so the `| undefined` is gone — it only ever
  // described the unimplemented ManyToMany case. This matches ModelBase.populate's static stub.
  populate(this: ModelBase, relation: string, owner: ModelBase | number | string): SelectQueryBuilder {
    //TODO: fix cast
    const modelDescriptor = (this as any).getModelDescriptor() as IModelDescriptor;

    if (!modelDescriptor) {
      throw new OrmException(`Model ${this.constructor.name} has no descriptor`);
    }

    if (!modelDescriptor.Relations.has(relation)) {
      throw new OrmException(`Model ${this.constructor.name} has no relation ${relation}`);
    }

    const relationDescriptor = modelDescriptor.Relations.get(relation)!;

    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data;
      },
      modelCreation(_: any): ModelBase {
        return DI.resolve<ModelBase>('__orm_model_factory__', [relationDescriptor.TargetModel]);
      },
      async afterHydration(_relationData: ModelBase[]) { },
    };

    switch (relationDescriptor.Type) {
      case RelationType.One: {
        const { query: JoinQuery } = createQuery(relationDescriptor.SourceModel!, SelectQueryBuilder);

        // NOTE: we could use simple right join, but we use LEFT JOIN
        // becouse sqlite does not support right join

        // UPDATE: newest sqlite engine does support right join
        // but nodejs drivers use older version of sqlite

        JoinQuery.leftJoin({
          joinModel: relationDescriptor.TargetModel,
          queryCallback: function () {
            this.select(new RawQuery(`\`${this.TableAlias}\`.*`));
          },
          // Both were omitted, so the join compiled to `$source$.undefined`. A belongsTo
          // joins the owner's ForeignKey to the target's PrimaryKey — the same derivation
          // SelectQueryBuilder uses for RelationType.One.
          sourceTablePrimaryKey: relationDescriptor.ForeignKey,
          joinTableForeignKey: relationDescriptor.PrimaryKey,
        } as any);

        // `wherePk`, not `where(descriptor.PrimaryKey, ...)`: PrimaryKey is a string[] since
        // composite keys landed, and passing the array as a column name compiled to
        // `column 0 not exists in model ...`.
        wherePk(JoinQuery, relationDescriptor.SourceModel!.getModelDescriptor(), owner instanceof ModelBase ? owner.PrimaryKeyValue : owner);
        JoinQuery.middleware(hydrateMiddleware);
        return JoinQuery;
      }

      case RelationType.ManyToMany: {
        // Was a bare `break`, so this returned undefined and every caller crashed on the
        // result. Read the junction table, join the target, and project the target's columns
        // — the same shape ManyToManyRelation.compile() builds. A sub-query would be more
        // direct but `whereIn` takes value arrays only.
        if (!relationDescriptor.JunctionModel) {
          throw new OrmException(`relation ${relation} on ${modelDescriptor.Name} has no junction model`);
        }

        const { query: junctionQuery } = createQuery(relationDescriptor.JunctionModel, SelectQueryBuilder);

        junctionQuery.clearColumns();
        junctionQuery.leftJoin({
          joinModel: relationDescriptor.TargetModel,
          queryCallback: function () {
            this.select(new RawQuery(`\`${this.TableAlias}\`.*`));
          },
          sourceTablePrimaryKey: relationDescriptor.JunctionModelTargetModelFKey_Name,
          joinTableForeignKey: relationDescriptor.ForeignKey,
        } as any);

        junctionQuery.where(relationDescriptor.JunctionModelSourceModelFKey_Name!, owner instanceof ModelBase ? owner.PrimaryKeyValue : owner);
        junctionQuery.middleware(hydrateMiddleware);

        return junctionQuery;
      }

      case RelationType.Virtual:
      case RelationType.Query:
        throw new OrmException(`Query population for relation type ${RelationType[relationDescriptor.Type]} is not supported yet`);

      case RelationType.Many: {
        const { query } = createQuery(relationDescriptor.TargetModel, SelectQueryBuilder);
        query.where(relationDescriptor.ForeignKey, owner instanceof ModelBase ? owner.PrimaryKeyValue : owner);
        return query;
      }

      default:
        throw new OrmException(`unknown relation type ${relationDescriptor.Type} for relation ${relation} on ${modelDescriptor.Name}`);
    }
  },

  query(): SelectQueryBuilder {
    const { query } = createQuery(this, SelectQueryBuilder);
    return query;
  },

  select(): SelectQueryBuilder {
    const { query } = createQuery(this, SelectQueryBuilder);
    query.select('*');
    return query;
  },

  where(column: string | boolean | WhereFunction<any> | RawQuery | Wrap | {}, operator?: Op | any, value?: any): SelectQueryBuilder {
    const { query } = createQuery(this, SelectQueryBuilder);
    query.select('*');

    return query.where(column, operator, value);
  },

  update<T extends typeof ModelBase>(data: Partial<InstanceType<T>>) {
    if (data instanceof ModelBase) {
      throw new OrmException(`use model::update() function to update model`);
    }

    const { query } = createQuery(this, UpdateQueryBuilder);
    return query.update(data);
  },

  all(page?: number, perPage?: number) {
    const { query } = createQuery(this, SelectQueryBuilder);

    query.select('*');
    if (page !== undefined && page >= 0 && perPage !== undefined && perPage > 0) {
      query.take(perPage).skip(page * perPage);
    }

    return query;
  },

  /**
   * Try to insert new value
   */
  async insert<T extends typeof ModelBase>(this: T, data: InstanceType<T> | Partial<InstanceType<T>> | Array<InstanceType<T>> | Array<Partial<InstanceType<T>>>, insertBehaviour: InsertBehaviour = InsertBehaviour.None) {


    const { query, description, container } = createQuery(this, InsertQueryBuilder);

    const converter = container.resolve(ObjectToSqlConverter);
    const sResponseMapper = query.Container.resolve(ServerResponseMapper);

    if (Array.isArray(data)) {
      if(data.length === 0) {
        return;
      }
      
      if (insertBehaviour !== InsertBehaviour.None) {
        throw new OrmException(`insert behaviour is not supported with arrays`);
      }

      // Run the key strategies over every element BEFORE any SQL is built, so a missing
      // `assigned` key fails with a clear message instead of a NOT NULL violation.
      (data as Array<InstanceType<T>>).forEach((d) => {
        generateClientSideKeys(d, description);
        assertAssignedKeys(d, description);
      });

      query.values(
        (data as Array<InstanceType<T>>).map((d) => {
          if (d instanceof ModelBase) {
            return d.toSql();
          }
          return converter.toSql(d, description);
        }),
      );
    } else {
      switch (insertBehaviour) {
        case InsertBehaviour.InsertOrIgnore:
          query.orIgnore();
          break;
        case InsertBehaviour.InsertOrUpdate:
          query.onDuplicate().update(description.Columns.filter((c) => !c.PrimaryKey).map((c) => c.Name));
          break;
        case InsertBehaviour.InsertOrReplace:
          query.orReplace();
          break;
      }

      generateClientSideKeys(data, description);
      assertAssignedKeys(data, description);

      if (data instanceof ModelBase) {
        query.values(data.toSql());
      } else {
        query.values(converter.toSql(data, description) as {} | {}[]);
      }
    }

    const autoKey = pkColumns(description).some((c) => pkGeneration(description, c) === 'auto');
    if (autoKey && query.Driver.supportedFeatures().insertReturning) {
      query.returning(pkColumns(description));
    }

    const iMidleware = {
      afterQuery: (result: IInsertResult) => {
        const response = sResponseMapper.read(result, pkColumns(description));
        const rows = Array.isArray(data) ? (data as Array<InstanceType<T>>) : [data as InstanceType<T>];

        if ((response.Returning ?? []).length === rows.length) {
          // Authoritative: the database told us every key it assigned, in insert order.
          rows.forEach((v, idx) => {
            if (v instanceof ModelBase) {
              setPkValue(v, description, pkValueOf(response.Returning[idx], description));
            }
          });
        } else if (autoKey && rows.length === 1) {
          // One row, one identity value - safe.
          const v = rows[0];
          if (v instanceof ModelBase && !v.PrimaryKeyValue) {
            v.PrimaryKeyValue = response.LastInsertId;
          }
        } else if (_canBackfillContiguousKeys(description, rows, response, query.Driver.supportedFeatures(), insertBehaviour)) {
          // Multi-row `INSERT ... VALUES` on a dialect with no RETURNING whose identity value is
          // the first of the statement's contiguous block. See _canBackfillContiguousKeys.
          rows.forEach((v, idx) => {
            (v as ModelBase).PrimaryKeyValue = response.LastInsertId + idx;
          });
        }
        // Anything else — a dialect whose insert id names the last row, a batch that mixed
        // supplied and generated keys, a statement the server did not insert one row per input
        // row for — cannot be mapped positionally, so nothing is assigned. Callers needing the
        // keys there must re-select or insert the models one at a time.

        // Every persist path re-baselines after its statement, and the baseline is taken after
        // the backfill above so it carries whatever key the statement produced: the model is
        // re-baselined to exactly what the statement wrote, no more. The relation keys are
        // written back first because the payload took them from the relation ( `toSql()` reads
        // the target's join column ) and not from the model's own foreign-key column - without
        // the write-back the baseline would record a column value the row does not hold, and the
        // model would read dirty right after a successful insert.
        //
        // A plain-object payload is not a model and has nothing to snapshot; a model whose key
        // could not be mapped positionally is still in the database, so it is re-baselined too -
        // it just carries no key, and cannot be updated through this instance until one is set.
        rows.forEach((v) => {
          if (v instanceof ModelBase) {
            // Private instance member - the static side of the class cannot see it.
            (v as any).writeBackRelationKeys();
            v.takeSnapshot();
          }
        });

        return result;
      },
      modelCreation: (): any => null,
      afterHydration: (): any => null,
    };

    query.middleware(iMidleware);

    return query;
  },

  async find<T extends typeof ModelBase>(this: T, pks: any[]): Promise<Array<InstanceType<T>>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);
    query.select('*');
    whereAnyPk(query, description, pks);
    return await (query as SelectQueryBuilder<Array<InstanceType<T>>>);
  },

  async findOrFail<T extends typeof ModelBase>(this: T, pks: any[]): Promise<Array<InstanceType<T>>> {
    const { query, description, model } = createQuery(this as any, SelectQueryBuilder);

    query.select('*');
    whereAnyPk(query, description, pks);

    const result = await (query as SelectQueryBuilder<Array<InstanceType<T>>>);

    if (result.length !== pks.length) {
      throw new Error(`could not find all results for model ${model.name}`);
    }

    return result;
  },

  async get<T extends typeof ModelBase>(this: T, pk: any): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);

    query.select('*');
    wherePk(query, description, pk);

    _prepareOrderBy(description, query);

    return (await query.first()) as unknown as Promise<InstanceType<T>>;
  },

  async getOrFail<T extends typeof ModelBase>(this: T, pk: any): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);

    query.select('*');
    wherePk(query, description, pk);

    _prepareOrderBy(description, query);

    return (await query.firstOrFail()) as unknown as Promise<InstanceType<T>>;
  },

  destroy<T extends typeof ModelBase>(pks?: any | any[]): IWhereBuilder<InstanceType<T>> {
    const description = _descriptor(this)!;

    if (pks === undefined || pks === null) {
      throw new OrmException('Cannot destroy without primary keys ( unbounded DELETE/UPDATE ). Use truncate() to clear the whole table.');
    }

    const data = Array.isArray(pks) ? pks : [pks];
    if (data.length === 0) {
      throw new OrmException('Cannot delete empty array of primary keys');
    }

    const { query } = description.SoftDelete?.DeletedAt ? createQuery(this, UpdateQueryBuilder) : createQuery(this, DeleteQueryBuilder);

    if (description.SoftDelete?.DeletedAt) {
      (query as UpdateQueryBuilder<never>).update({
        [description.SoftDelete.DeletedAt]: DateTime.now(),
      });
    }

    if (pks) {
      whereAnyPk(query as unknown as IWhereBuilder<any>, description, data);
    }

    return query;
  },

  async create<T extends typeof ModelBase>(this: T, data: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const entity = new (Function.prototype.bind.apply(this))(data);
    await (entity as ModelBase).insert();
    return entity;
  },

  async getOrCreate<T extends typeof ModelBase>(this: T, pk: string | number | null, data: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);

    // pk constrain
    if (hasPk(description) && pk !== null) {
      wherePk(query, description, pk);
    }

    // check for all unique columns ( unique constrain )
    description.Columns.filter((c) => c.Unique).forEach((c) => {
      query.andWhere(c.Name, (data as any)[c.Name]);
    });

    _prepareOrderBy(description, query);

    let entity = (await query.first()) as any;

    if (!entity) {
      entity = new (Function.prototype.bind.apply(this))(data);
      await (entity as ModelBase).insert();
      return entity;
    }

    return entity;
  },

  async getOrNew<T extends typeof ModelBase>(this: T, data?: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);

    // check for all unique columns ( unique constrain )
    // skip columns that don't have a value in the provided data
    description.Columns.filter((c) => c.Unique || c.PrimaryKey).forEach((c) => {
      const value = (data as any)?.[c.Name];
      if (value !== undefined) {
        query.andWhere(c.Name, value);
      }
    });

    _prepareOrderBy(description, query);

    let entity = (await query.first()) as any;

    if (!entity) {

      const toHydrate = data ?? {};
      // Do not carry an auto-increment key into a brand new model; the engine assigns it.
      // Every key column is checked, not just the first, so a composite key with an
      // auto-increment member is stripped correctly.
      pkColumns(description).forEach((name) => {
        const col = description.Columns.find((c) => c.Name === name);
        if (col?.AutoIncrement) {
          delete (toHydrate as any)[name];
        }
      });

      entity = new (Function.prototype.bind.apply(this))(toHydrate);
      return entity;
    }

    return entity;
  },

  async exists<T extends typeof ModelBase>(this: T, pk: any) {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);
    // pk constrain
    if (hasPk(description) && pk !== null) {
      wherePk(query, description, pk);
    }

    const q = query.clearColumns();
    pkColumns(description).forEach((c) => q.select(c));

    const result = await q.first();
    if (result) {
      return true;
    }

    return false;
  },

  whereExists<T extends typeof ModelBase, Z extends ModelBase<unknown> | ModelBase<unknown>[]>(this: T, qOrRel: ISelectQueryBuilder<Z> | string, callback: WhereFunction<InstanceType<T>>) {
    const { query } = createQuery(this as any, SelectQueryBuilder);

    query.whereExist(qOrRel, callback);

    return query;
  },

  whereNotExists<T extends typeof ModelBase, Z extends ModelBase<unknown> | ModelBase<unknown>[]>(this: T, qOrRel: ISelectQueryBuilder<Z> | string, callback: WhereFunction<InstanceType<T>>) {
    const { query } = createQuery(this as any, SelectQueryBuilder);

    query.whereNotExists(qOrRel, callback);

    return query;
  },

  async first<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);
    _prepareOrderBy(description, query, SortOrder.ASC);

    if (callback) {
      callback(query);
    }

    return (await query.first()) as unknown as Promise<InstanceType<T>>;
  },

  async last<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);
    _prepareOrderBy(description, query, SortOrder.DESC);

    if (callback) {
      callback(query);
    }

    return (await query.first()) as unknown as Promise<InstanceType<T>>;
  },

  async newest<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);

    if (description.Timestamps?.CreatedAt) {
      query.order(description.Timestamps.CreatedAt, SortOrder.DESC);
    } else {
      throw new OrmException('cannot fetch newest entity - CreateAt column not exists in model/db');
    }

    if (callback) {
      callback(query);
    }

    return (await query.first()) as unknown as Promise<InstanceType<T>>;
  },

  async oldest<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);

    if (description.Timestamps?.CreatedAt) {
      query.order(description.Timestamps.CreatedAt, SortOrder.ASC);
    } else {
      throw new OrmException('cannot fetch oldest entity - CreateAt column not exists in model/db');
    }

    if (callback) {
      callback(query);
    }

    return (await query.first()) as unknown as Promise<InstanceType<T>>;
  },

  async count<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<number> {
    const { query } = createQuery(this as any, SelectQueryBuilder);

    query.count('*', 'count');

    if (callback) {
      callback(query);
    }

    const row = await query.takeFirst().asRaw<{ count: number }>();
    return row?.count ?? 0;
  },

  async transaction<T extends typeof ModelBase>(this: T, callback: (trx: OrmDriver) => Promise<void>) {
    const driver = this.getModelDescriptor();
    return driver.Driver!.transaction(callback);
  }
};

export const _modelProxyFactory = (_c: IContainer, model: Constructor<ModelBase>) => {
  return new model();
};

DI.register(_modelProxyFactory).as('__orm_model_factory__');
