/* eslint-disable prettier/prettier */
import { IRelationDescriptor, IModelDescriptor, InsertBehaviour, ForwardRefFunction, IRelation, ISelectQueryBuilder } from './interfaces.js';
import { DI, Constructor, isConstructor, NewInstance } from '@spinajs/di';
import { createQuery, SelectQueryBuilder } from './builders.js';
import type { ModelBase } from './model.js';
import { Orm } from './orm.js';
import _ from 'lodash';
import { OrmDriver } from './driver.js';
import { extractModelDescriptor } from './descriptor.js';

export class Dataset {
  /**
   *
   * Calculates difference between data in this relation and provides set. Result is saved to db.
   *
   * @param dataset - data to compare
   * @param callback - function to compare objects, if none provideded - primary key value is used
   */
  public static diff<R>(dataset: R[], callback?: (a: R, b: R) => boolean) {
    return (datasetB: R[], pKey: string) => {
      // TODO: maybe refactor for speedup, this is not optimal
      // two calls to _.difference is not optimal, but it is easy to implement

      // calculate difference between this data in relation and dataset ( objects from this relation)
      const result = callback ? _.differenceWith(dataset, [...datasetB], callback) : _.differenceBy(dataset, [...datasetB], pKey);

      // calculate difference between dataset and data in this relation ( objects from dataset )
      const result2 = callback ? _.differenceWith([...datasetB], dataset, callback) : _.differenceBy([...datasetB], dataset, pKey);

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
    return (datasetB: R[], pKey: string) => {
      return callback ? _.intersectionWith(dataset, [...datasetB], callback) : _.intersectionBy(dataset, [...datasetB], pKey);
    };
  }
}

/**
 * Iterable list of populated relation entities
 *
 * It allows to add / remove objects to relation
 */
@NewInstance()
export abstract class Relation<R extends ModelBase<R>, O extends ModelBase<O>> extends Array<R> implements IRelation<R, O> {
  public TargetModelDescriptor: IModelDescriptor;

  public Populated: boolean = false;

  protected Driver: OrmDriver;

  protected IsModelAForwardRef: boolean;

  protected Model: Constructor<R> | ForwardRefFunction;

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
  public abstract set(obj: R[] | ((data: R[], pKey: string) => R[])): void;

  /**
   * Populates this relation ( loads all data related to owner of this relation)
   */
  public abstract populate(callback?: (this: ISelectQueryBuilder<this>) => void): Promise<void>;
}

@NewInstance()
export class SingleRelation<R extends ModelBase, O extends ModelBase = ModelBase> {
  public TargetModelDescriptor: IModelDescriptor;

  protected Orm: Orm;

  public Value: R;

  public Populated: boolean = false;

  constructor(protected _owner: O, protected model: Constructor<R> | ForwardRefFunction, protected Relation: IRelationDescriptor, object?: R) {
    this.TargetModelDescriptor = extractModelDescriptor(model);
    this.Orm = DI.get(Orm);

    this.Value = object;
  }

  public async set(obj: R) {
    this.attach(obj);
    await this._owner.update();
  }

  public attach(obj: R) {
    this.Value = obj;
    this._owner.IsDirty = true;

    // TODO hack for dirty props
    (this._owner as any).__dirty_props__.push(this.Relation.ForeignKey);
  }

  public detach() {
    this.attach(null);
  }

  public async remove() {
    this.detach();
    await this.Value.destroy();
    await this._owner.update();
  }

  public async populate(callback?: (this: SelectQueryBuilder<this>) => void): Promise<void> {
    /**
     * Do little cheat - we construct query that loads initial model with given relation.
     * Then we only assign relation property.
     *
     * TODO: create only relation query without loading its owner.
     */

    const query = createQuery(this.Relation.TargetModel, SelectQueryBuilder<ModelBase>).query;
    const desc = extractModelDescriptor(this.Relation.TargetModel);
    query.where({ [desc.PrimaryKey]: (this._owner as any)[this.Relation.ForeignKey] });

    if (callback) {
      callback.apply(query);
    }

    const relColumn = this._owner.ModelDescriptor.Columns.find((c) => c.Name === this.Relation.ForeignKey);
    if (relColumn.Nullable) {
      this.Value = await query.first();
    } else {
      this.Value = await query.firstOrFail();
    }
    this.Populated = true;
  }
}

@NewInstance()
export class ManyToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T, O> {

  protected junctionModelDescriptor: IModelDescriptor;

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

  public set(obj: T[], _callback?: (a: T, b: T) => boolean): void {
    const toPush = _.isFunction(obj) ? obj([...this], this.TargetModelDescriptor.PrimaryKey) : obj;
    this.empty();
    this.push(...toPush);
  }

  public remove(_obj: T | T[] | ((a: T) => boolean)): T[] {
    throw new Error('Method not implemented.');
  }

  /**
  * Deletes from db data that are not in relation
  *
  * @param data relation data
  * @returns
  */
  protected async _dbDiff(data: T[]) {
    const query = this.Driver.del().from(this.junctionModelDescriptor.TableName).where(this.Relation.JunctionModelSourceModelFKey_Name, this.Owner.PrimaryKeyValue);

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    // if we have data in relation, we need to exclude them from delete query
    const toDelete = [...data].filter((x) => x.PrimaryKeyValue).map((x) => x.PrimaryKeyValue);
    if (toDelete.length !== 0) {
      query.whereNotIn(this.junctionModelDescriptor.PrimaryKey, toDelete);
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
      const junctionEntry = new (this.Relation.JunctionModel as any)();
      (junctionEntry as any)[this.Relation.JunctionModelSourceModelFKey_Name] = this.Owner.PrimaryKeyValue;
      (junctionEntry as any)[this.Relation.JunctionModelTargetModelFKey_Name] = f.PrimaryKeyValue;
      await junctionEntry.insert(InsertBehaviour.InsertOrUpdate);
    }
  }


  public async populate(callback?: (this: ISelectQueryBuilder<this>) => void) {
    const query = (this.Relation.JunctionModel as any).where((this as any).Relation.JunctionModelSourceModelFKey_Name, this.Owner.PrimaryKeyValue).populate(
      this.Relation.TargetModel
    )

    if (callback) {
      callback.apply(query);
    }
    const result = await query;

    if (result) {
      this.length = 0;

      this.push(...result.map((r : any) => {
        return r[this.Relation.TargetModel.name].Value;
      }));
    }

    this.Populated = true;
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
export class OneToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T, O> {
  /**
   * Deletes from db data that are not in relation
   *
   * @param data relation data
   * @returns
   */
  protected async _dbDiff(data: T[]) {
    const query = this.Driver.del().from(this.TargetModelDescriptor.TableName).where(this.Relation.ForeignKey, this.Owner.PrimaryKeyValue);

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    // if we have data in relation, we need to exclude them from delete query
    const toDelete = data.filter((x) => x.PrimaryKeyValue).map((x) => x.PrimaryKeyValue);
    if (toDelete.length !== 0) {
      query.whereNotIn(this.TargetModelDescriptor.PrimaryKey, toDelete);
    }

    await query;
  }

  /**
   * Populates this relation ( loads all data related to owner of this relation)
   */
  public async populate(callback?: (this: ISelectQueryBuilder<this>) => void): Promise<void> {
    const query = (this.Relation.TargetModel as any).where(this.Relation.ForeignKey, this.Owner.PrimaryKeyValue);
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
    const dirty = this.filter((x) => x.IsDirty || x.PrimaryKeyValue === null);

    this.forEach((d) => {
      (d as any)[this.Relation.ForeignKey] = this.Owner.PrimaryKeyValue;
    });

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
    return Dataset.diff(dataset, callback)([...this], this.TargetModelDescriptor.PrimaryKey);
  }

  /**
   * Sets data in relation ( clear data and replace with new dataset )
   *
   * @param obj
   */
  public set(obj: T[] | ((data: T[], pKeyName: string) => T[])) {
    const toPush = _.isFunction(obj) ? obj([...this], this.TargetModelDescriptor.PrimaryKey) : obj;
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
    return Dataset.intersection(obj, callback)([...this], this.TargetModelDescriptor.PrimaryKey);
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
  public filter(predicate: (value: T, index?: number, array?: T[]) => boolean): T[] {
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
