/* eslint-disable prettier/prettier */
import { IRelationDescriptor, IModelDescriptor, InsertBehaviour, ForwardRefFunction, IRelation, ISelectQueryBuilder, QueryScope } from './interfaces.js';
import { DI, Constructor, isConstructor, NewInstance } from '@spinajs/di';
import { createQuery, SelectQueryBuilder } from './builders.js';
import type { ModelBase } from './model.js';
import { Orm } from './orm.js';
import _ from 'lodash';
import { OrmDriver } from './driver.js';
import { extractModelDescriptor } from './descriptor.js';
import { isCompositePk, pkColumns, pkKeyStringFor, pkValueOf, whereNotAnyPk } from './primary-keys.js';
import { OrmException } from './exceptions.js';

/**
 * Builds a lodash iteratee for the given primary key columns. A single column stays a plain
 * property name ( lodash's fast path ); a composite key becomes a function that flattens the
 * tuple, because an array iteratee would be read as a property PATH — `_.differenceBy(a, b,
 * ['TenantId','Code'])` resolves `obj['TenantId']['Code']`, undefined for every row, so every
 * row would compare equal.
 */
function pkIteratee(pKey: string[]): string | ((x: any) => string) {
  if (pKey.length === 1) {
    return pKey[0];
  }

  return (x: any) => pkKeyStringFor(x, pKey);
}

export class Dataset {
  /**
   *
   * Calculates difference between data in this relation and provides set. Result is saved to db.
   *
   * @param dataset - data to compare
   * @param callback - function to compare objects, if none provideded - primary key value is used
   */
  public static diff<R>(dataset: R[], callback?: (a: R, b: R) => boolean) {
    return (datasetB: R[], pKey: string[]) => {
      // TODO: maybe refactor for speedup, this is not optimal
      // two calls to _.difference is not optimal, but it is easy to implement
      const iteratee = pkIteratee(pKey);

      // calculate difference between this data in relation and dataset ( objects from this relation)
      const result = callback ? _.differenceWith(dataset, [...datasetB], callback) : _.differenceBy(dataset, [...datasetB], iteratee as any);

      // calculate difference between dataset and data in this relation ( objects from dataset )
      const result2 = callback ? _.differenceWith([...datasetB], dataset, callback) : _.differenceBy([...datasetB], dataset, iteratee as any);

      // combine difference from two sets
      const finalDiff = [...result, ...result2];

      return finalDiff;
    };
  }

  /**
   *
   * Calculates intersection between data in this relation and provided dataset
   * It saves result to db
   *
   * @param dataset - dataset to compare
   * @param callback - function to compare models, if not set it is compared by primary key value
   */
  public static intersection<R>(dataset: R[], callback?: (a: R, b: R) => boolean) {
    return (datasetB: R[], pKey: string[]) => {
      const iteratee = pkIteratee(pKey);
      return callback ? _.intersectionWith(dataset, [...datasetB], callback) : _.intersectionBy(dataset, [...datasetB], iteratee as any);
    };
  }
}

/**
 * Iterable list of populated relation entities
 *
 * It allows to add / remove objects to relation
 */
@NewInstance()
export abstract class Relation<R extends ModelBase<R>, O extends ModelBase<O>, Q extends typeof ModelBase<R> = typeof ModelBase<R>> extends Array<R> implements IRelation<R, O> {
  public TargetModelDescriptor: IModelDescriptor | null;

  public Populated: boolean = false;

  protected Driver: OrmDriver;

  protected IsModelAForwardRef: boolean;

  protected Model: Constructor<R> | ForwardRefFunction;

  /**
   * Array methods that derive a new collection ( `splice`, `filter`, `slice`, `concat`, … )
   * construct `new this.constructor[Symbol.species](len)` by default. That would call this
   * class's constructor with no relation descriptor, and the very next line dereferences
   * `this.Relation.TargetModel` — so `order.Items.splice(0, 1)` threw
   * `Cannot read properties of undefined (reading 'TargetModel')`.
   *
   * Deriving plain arrays is also the right semantics: a slice of a relation is a list of
   * models, not a relation with an owner. ( The hand-written `map()` below predates this and
   * worked around the same thing for one method. )
   */
  static get [Symbol.species]() {
    return Array;
  }

  constructor(protected Owner: O, protected Relation: IRelationDescriptor, objects?: R[]) {
    super();

    if (objects) {
      this.push(...objects);
    }

    this.Model = this.Relation.TargetModel as any; // TODO: fix typings
    this.TargetModelDescriptor = extractModelDescriptor(this.Model);

    if (this.TargetModelDescriptor) {
      this.Driver = DI.resolve<OrmDriver>('OrmConnection', [this.TargetModelDescriptor.Connection]);
    }

    this.IsModelAForwardRef = !isConstructor(this.Model);
  }

  /**
   * The owner-side value this relation joins on.
   *
   * A relation names exactly ONE source column (`IRelationDescriptor.PrimaryKey`), so a
   * composite-key owner must contribute only that column's value. `Owner.PrimaryKeyValue`
   * would be a tuple, which binds an array into a single `?` and fails with
   * `SQLITE_RANGE: column index out of range`.
   *
   * For a single-column key `Relation.PrimaryKey` IS the model's key column, so this returns
   * exactly what `Owner.PrimaryKeyValue` did.
   */
  protected get OwnerJoinValue(): any {
    const key = this.Relation?.PrimaryKey;
    return key ? (this.Owner as any)[key] : this.Owner.PrimaryKeyValue;
  }

  public map<U>(callbackfn: (value: R, index: number, array: R[]) => U, thisArg?: any): U[] {
    const result: U[] = [];
    for (let index = 0; index < this.length; index++) {
      const element = this[index];
      result.push(callbackfn.call(thisArg, element, index, this));
    }

    return result;
  }

  /**
   * Removes all objects from relation by comparison functions
   *
   * @param compare function to compare models
   */
  public abstract remove(compare: (a: R) => boolean): R[];

  /**
   * Removes all objects by primary key
   *
   * @param obj - data to remove
   */
  public abstract remove(obj: R | R[]): R[];

  /**
   * Removes from relation & deletes from db
   *
   * @param obj - data to remove
   */
  public abstract remove(obj: R | R[] | ((a: R, b: R) => boolean)): R[];

  /**
   * Delete all objects from relation ( alias for empty )
   */
  public async clear(): Promise<void> {
    this.empty();
  }

  /**
   * Clears relation data
   */
  public empty() {
    this.length = 0;
  }

  /**
   * Synchronize relation data with db
   * NOTE: it removes data from db that are not in relation
   *
   * @param obj - object to add
   * @param mode - insert mode
   */
  public abstract sync(): Promise<void>;

  /**
   * Updates or ads data to relation
   * It will not delete data from db that are not in relation. It will only update or insert new data.
   * Only dirty models are updated.
   */
  public abstract update(): Promise<void>;

  /**
   *
   * Calculates intersection between data in this relation and provided dataset
   * It saves result to db
   *
   * @param dataset - dataset to compare
   * @param callback - function to compare models, if not set it is compared by primary key value
   */
  public abstract intersection(dataset: R[], callback?: (a: R, b: R) => boolean): R[];

  /**
   * Adds all items to this relation & adds to database
   *
   * @param dataset - data to add
   * @param mode - insert mode
   */
  public abstract union(dataset: R[], mode?: InsertBehaviour): void;

  /**
   *
   * Calculates difference between data in this relation and provides set. Result is saved to db.
   *
   * @param dataset - data to compare
   * @param callback - function to compare objects, if none provideded - primary key value is used
   */
  public abstract diff(dataset: R[], callback?: (a: R, b: R) => boolean): R[];

  /**
   *
   * Clears data and replace it with new dataset.
   *
   * @param dataset - data for replace.
   */
  public abstract set(obj: R[] | ((data: R[], pKey: string[]) => R[])): void;

  /**
   * Populates this relation ( loads all data related to owner of this relation)
   */
  public abstract populate(callback?: (this: ISelectQueryBuilder<R[]> & Q['_queryScopes']) => void): Promise<void>;
}

@NewInstance()
export class SingleRelation<R extends ModelBase, O extends ModelBase = ModelBase> {
  public TargetModelDescriptor: IModelDescriptor | null;

  protected Orm: Orm;

  public Value: R | null | undefined;

  public Populated: boolean = false;

  constructor(protected _owner: O, protected model: Constructor<R> | ForwardRefFunction | null, protected Relation: IRelationDescriptor | null, object?: R) {
    this.TargetModelDescriptor = model ? extractModelDescriptor(model) : null;
    this.Orm = DI.get(Orm)!;

    this.Value = object;
  }

  public async set(obj: R) {
    this.attach(obj);
    await this._owner.update();
  }

  public attach(obj: R | null) {
    this.Value = obj;
    this._owner.IsDirty = true;

    // TODO hack for dirty props
    (this._owner as any).__dirty_props__.push(this.Relation?.ForeignKey);
  }

  public detach() {
    this.attach(null);
  }

  public async remove() {
    const val = this.Value;
    this.detach();
    await val?.destroy();
    await this._owner.update();
  }

  public async populate(callback?: (this: SelectQueryBuilder<this>) => void): Promise<void> {
    /**
     * Do little cheat - we construct query that loads initial model with given relation.
     * Then we only assign relation property.
     *
     * TODO: create only relation query without loading its owner.
     */

    const query = createQuery(this.Relation!.TargetModel, SelectQueryBuilder<ModelBase>).query;
    const desc = extractModelDescriptor(this.Relation!.TargetModel);
    query.where({ [desc!.PrimaryKey[0]]: (this._owner as any)[this.Relation!.ForeignKey] });

    if (callback) {
      callback.apply(query);
    }

    const relColumn = this._owner.ModelDescriptor?.Columns.find((c) => c.Name === this.Relation!.ForeignKey);
    if (relColumn?.Nullable) {
      this.Value = await query.first();
    } else {
      this.Value = await query.firstOrFail();
    }
    this.Populated = true;
    this._owner.snapshotRelation(this.Relation!.Name);
  }
}

export class ManyQueryRelationList<R extends ModelBase, O extends ModelBase> extends Relation<R, O, typeof ModelBase<R>> {
  public remove(_compare: (a: R) => boolean): R[];
  /* eslint-disable prettier/prettier */
  public remove(_obj: R | R[]): R[];
  /* eslint-disable prettier/prettier */
  public remove(_obj: R | R[] | ((a: R, b: R) => boolean)): R[];
  /* eslint-disable prettier/prettier */
  public remove(_obj: unknown): R[] {
    throw new Error('Query relations cannot be removed. This relation is used only for query purposes and it is always populated.');
  }
  public sync(): Promise<void> {
    throw new Error('Query relations cannot be synced. This relation is used only for query purposes and it is always populated.');
  }
  public update(): Promise<void> {
    throw new Error('Query relations cannot be updated. This relation is used only for query purposes and it is always populated.');
  }
  public intersection(_dataset: R[], _callback?: (a: R, b: R) => boolean): R[] {
    throw new Error('Query relations cannot be intersected. This relation is used only for query purposes and it is always populated.');
  }
  public union(_dataset: R[], _mode?: InsertBehaviour): void {
    throw new Error('Query relations cannot be unioned. This relation is used only for query purposes and it is always populated.');
  }
  public diff(_dataset: R[], _callback?: (a: R, b: R) => boolean): R[] {
    throw new Error('Query relations cannot be diffed. This relation is used only for query purposes and it is always populated.');
  }
  public set(_obj: R[] | ((data: R[], pKey: string[]) => R[])): void {
    throw new Error('Query relations cannot be set. This relation is used only for query purposes and it is always populated.');
  }
  public populate(_callback?: (this: ISelectQueryBuilder<R[]> & QueryScope) => void): Promise<void> {
    throw new Error('Query relations cannot be populated. This relation is used only for query purposes and it is always populated.');
  }
  constructor(owner: O, relation: IRelationDescriptor, objects?: R[]) {
    super(owner, relation, objects);
    this.Populated = true;
  }
}

export class SingleQueryRelation<R extends ModelBase, O extends ModelBase = ModelBase> extends SingleRelation<R, O> {
  constructor(owner: O, object: R) {
    super(owner, null, null, object as R);
    this.Populated = true;
  }
}

@NewInstance()
export class ManyToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T, O, typeof ModelBase<T>> {

  protected junctionModelDescriptor: IModelDescriptor | null;

  constructor(owner: O, relation: IRelationDescriptor, objects?: T[]) {
    super(owner, relation, objects);

    if (relation.JunctionModel) {
      this.junctionModelDescriptor = extractModelDescriptor(this.Relation.JunctionModel);
    }
  }

  public intersection(_obj: T[], _callback?: (a: T, b: T) => boolean): T[] {
    throw new Error('Method not implemented.');
  }

  public union(_obj: T[], _mode?: InsertBehaviour): void {
    throw new Error('Method not implemented.');
  }

  public diff(_obj: T[], _callback?: (a: T, b: T) => boolean): T[] {
    throw new Error('Method not implemented.');
  }

  /**
 * Sets data in relation ( clear data and replace with new dataset )
 *
 * @param obj
 */
  public set(obj: T[] | ((data: T[], pKeyName: string[]) => T[])) {
    const toPush = _.isFunction(obj) ? obj([...this], pkColumns(this.TargetModelDescriptor!)) : obj;
    this.empty();
    this.push(...toPush);
  }

  /**
   * Removes from relation & deletes from db
   *
   * @param obj - data to remove
   */
  public remove(func: (a: T) => boolean): T[];

  /**
   * Removes all objects that met condition
   * @param obj - predicate
   */
  public remove(obj: (a: T) => boolean): T[];

  /**
   * Removes all objects by primary key
   * @param obj data array to remove
   */
  public remove(obj: T[]): T[];

  /**
   * Removes object by primary key
   * @param obj data to remove
   * */
  public remove(obj: T): T[];
  public remove(obj: T | T[] | ((a: T) => boolean)): T[] {
    const toRemove = _.isFunction(obj) ? this.filter(obj) : Array.isArray(obj) ? obj : [obj];

    this.set((data) => {
      return data.filter((d) => !toRemove.includes(d));
    });

    return toRemove;
  }

  /**
  * Deletes from db data that are not in relation
  *
  * @param data relation data
  * @returns
  */
  protected async _dbDiff(data: T[]) {
    // A junction table carries exactly ONE foreign key column per side, so it cannot address
    // a composite target key. Fail loudly rather than delete the wrong rows.
    if (isCompositePk(this.TargetModelDescriptor!)) {
      throw new OrmException(`many-to-many relation ${this.Relation.Name} targets ${this.TargetModelDescriptor!.Name}, which has a composite primary key; a junction table carries one foreign key column per side and cannot address it`);
    }

    const query = this.Driver.del().from(this.junctionModelDescriptor!.TableName).where(this.Relation.JunctionModelSourceModelFKey_Name!, this.OwnerJoinValue);

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    // if we have data in relation, we need to exclude them from delete query
    const toDelete = [...data].filter((x) => x.PrimaryKeyValue).map((x) => x.PrimaryKeyValue);
    if (toDelete.length !== 0) {
      query.whereNotIn(this.Relation.JunctionModelTargetModelFKey_Name!, toDelete);
    }

    await query;
  }

  /**
    *  Synchronizes relation data to db
    *  Deletes from db entries that are not in relation and adds entries that are not in db
    *  Sets foreign key to relational data
    *
    *  Inserts or updates models that are dirty only.
    */
  public async sync() {
    await this.update();
    await this._dbDiff(this);
  }

  /**
   * Updates or ads data to relation
   * It will not delete data from db that are not in relation. It will only update or insert new data.
   * Only dirty models are updated.
   */
  public async update() {
    for (const f of this) {
      const junctionEntry = new this.Relation.JunctionModel!();
      const desc = junctionEntry.ModelDescriptor;
      const relationsArray = Array.from(desc!.Relations.values());
      const sourceModelRelation = relationsArray.find((r) => r.TargetModel === this.Owner.constructor);
      const targetModelRelation = relationsArray.find((r) => r.TargetModel === f.constructor);

      if (!sourceModelRelation) {
        throw new Error(`Junction model relation for source model ${this.Owner.constructor.name} not found.`);
      }

      if (!targetModelRelation) {
        throw new Error(`Junction model relation for target model ${f.constructor.name} not found.`);
      }

      (junctionEntry as any)[sourceModelRelation.Name].Value = this.Owner;
      (junctionEntry as any)[targetModelRelation.Name].Value = f;
      await junctionEntry.insert(InsertBehaviour.InsertOrUpdate);
    }
  }


  public async populate<Q extends typeof ModelBase>(callback?: (this: ISelectQueryBuilder<T[]> & Q['_queryScopes']) => void) {
    const query = (this.Relation.JunctionModel as any).where((this as any).Relation.JunctionModelSourceModelFKey_Name, this.OwnerJoinValue).populate(
      this.Relation.TargetModel, callback
    )

    const result = await query;

    if (result) {
      this.length = 0;

      this.push(...result.map((r: any) => {
        return r[this.Relation.TargetModel.name].Value;
      }));
    }

    this.Populated = true;
    this.Owner.snapshotRelation(this.Relation.Name);
  }

  // public async add(obj: T | T[], mode?: InsertBehaviour): Promise<void> {
  //   const data = Array.isArray(obj) ? obj : [obj];
  //   const relEntities = data.map((d) => {
  //     const relEntity = new this.Relation.JunctionModel();
  //     (relEntity as any)[this.Relation.JunctionModelSourceModelFKey_Name] = this.owner.PrimaryKeyValue;
  //     (relEntity as any)[this.Relation.JunctionModelTargetModelFKey_Name] = d.PrimaryKeyValue;

  //     return relEntity;
  //   });

  //   for (const m of relEntities) {
  //     await m.insert(mode);
  //   }

  //   this.push(...data);
  // }
}

@NewInstance()
export class OneToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T, O, typeof ModelBase<T>> {
  /**
   * Deletes from db data that are not in relation
   *
   * @param data relation data
   * @returns
   */
  protected async _dbDiff(data: T[]) {
    const query = this.Driver.del().from(this.TargetModelDescriptor!.TableName).where(this.Relation.ForeignKey, this.OwnerJoinValue);

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    // if we have data in relation, we need to exclude them from delete query.
    // A composite key is a tuple and always truthy, so filter on the key COLUMNS being set
    // rather than on the tuple itself.
    const keys = pkColumns(this.TargetModelDescriptor!);
    const toDelete = data
      .map((x) => pkValueOf(x, this.TargetModelDescriptor!))
      .filter((v) => (Array.isArray(v) ? v.every((p) => p !== null && p !== undefined) : v !== null && v !== undefined));

    if (toDelete.length !== 0 && keys.length !== 0) {
      whereNotAnyPk(query, this.TargetModelDescriptor!, toDelete);
    }

    await query;
  }

  /**
   * Populates this relation ( loads all data related to owner of this relation)
   */
  public async populate<Q extends typeof ModelBase>(callback?: (this: ISelectQueryBuilder<T[]> & Q['_queryScopes']) => void): Promise<void> {
    const query = (this.Relation.TargetModel as any).where(this.Relation.ForeignKey, this.OwnerJoinValue);
    if (callback) {
      callback.apply(query);
    }
    const result = await query;

    if (result) {
      this.length = 0;

      result.forEach((r: ModelBase) => {
        this.Owner.attach(r);
      });
    }

    this.Populated = true;
    this.Owner.snapshotRelation(this.Relation.Name);
  }

  /**
   *  Synchronizes relation data to db
   *  Deletes from db entries that are not in relation and adds entries that are not in db
   *  Sets foreign key to relational data
   *
   *  Inserts or updates models that are dirty only.
   */
  public async sync() {
    await this.update();
    await this._dbDiff(this);
  }

  /**
   * Updates or ads data to relation
   * It will not delete data from db that are not in relation. It will only update or insert new data.
   * Only dirty models are updated.
   */
  public async update() {
    // Assign foreign keys BEFORE computing the dirty set. A child re-parented to
    // this owner needs its FK rewritten and persisted; if we snapshot `dirty`
    // first, a previously-clean child keeps its old FK in the DB and a following
    // sync() can delete it as "not belonging" to the new owner.
    this.forEach((d) => {
      (d as any)[this.Relation.ForeignKey] = this.OwnerJoinValue;
    });

    // Fresh models have an undefined PK ( setDefaults uses the column default ),
    // so treat undefined as "needs insert" alongside null and the dirty flag.
    const dirty = this.filter((x) => x.IsDirty || x.PrimaryKeyValue === null || x.PrimaryKeyValue === undefined);

    for (const f of dirty) {
      await f.insert(InsertBehaviour.InsertOrUpdate);
    }
  }

  /**
   * Calculates difference between this relation and dataset ( items from this relation that are not in dataset and items from dataset that are not in this relation)
   *
   * @param dataset
   * @param callback
   * @returns Difference between this relation and dataset
   */
  public diff(dataset: T[], callback?: (a: T, b: T) => boolean) {
    return Dataset.diff(dataset, callback)([...this], pkColumns(this.TargetModelDescriptor!));
  }

  /**
   * Sets data in relation ( clear data and replace with new dataset )
   *
   * @param obj
   */
  public set(obj: T[] | ((data: T[], pKeyName: string[]) => T[])) {
    const toPush = _.isFunction(obj) ? obj([...this], pkColumns(this.TargetModelDescriptor!)) : obj;
    this.empty();
    this.push(...toPush);
  }

  /**
   * Calculates intersection between data in this relation and provided dataset
   *
   * @param obj
   * @param callback compare function, if not set - primary key value is used
   * @returns Data that are in both sets
   */
  public intersection(obj: T[], callback?: (a: T, b: T) => boolean) {
    return Dataset.intersection(obj, callback)([...this], pkColumns(this.TargetModelDescriptor!));
  }

  /**
   * Combines data with this relation and saves to db
   * Shorthand for push
   * @param obj
   */
  public union(obj: T[]) {
    this.push(...obj);
  }

  /**
   * Returns the elements of an array that meet the condition specified in a callback function.
   * @param predicate A function that accepts up to three arguments. The filter method calls the predicate function one time for each element in the array.
   */
  public filter(predicate: (value: T, index: number, array: T[]) => boolean): T[] {
    return [...this].filter(predicate);
  }

  /**
   * Removes from relation & deletes from db
   *
   * @param obj - data to remove
   */
  public remove(func: (a: T) => boolean): T[];

  /**
   * Removes all objects that met condition
   * @param obj - predicate
   */
  public remove(obj: (a: T) => boolean): T[];

  /**
   * Removes all objects by primary key
   * @param obj data array to remove
   */
  public remove(obj: T[]): T[];

  /**
   * Removes object by primary key
   * @param obj data to remove
   * */
  public remove(obj: T): T[];
  public remove(obj: T | T[] | ((a: T) => boolean)): T[] {
    const toRemove = _.isFunction(obj) ? this.filter(obj) : Array.isArray(obj) ? obj : [obj];

    this.set((data) => {
      return data.filter((d) => !toRemove.includes(d));
    });

    return toRemove;
  }

  public flatMap<V>(callback: (val: T, index: number, array: T[]) => V) {
    const r = this.map(callback);

    return r.flatMap(x => x) as any;
  }

  public map<V>(callback: (val: T, index: number, array: T[]) => V) {
    const r: V[] = [];
    this.forEach((x, i, a) => r.push(callback(x, i, a)));
    return r;
  }
}
