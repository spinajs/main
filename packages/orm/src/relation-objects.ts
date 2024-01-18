/* eslint-disable prettier/prettier */
import { IRelationDescriptor, IModelDescriptor, InsertBehaviour, ForwardRefFunction, IRelation, ISelectQueryBuilder } from './interfaces.js';
import { DI, Constructor, isConstructor } from '@spinajs/di';
import { SelectQueryBuilder } from './builders.js';
import { createQuery, extractModelDescriptor, ModelBase } from './model.js';
import { IModelBase } from './interfaces.js';
import { Orm } from './orm.js';
import _ from 'lodash';
import { OrmDriver } from './driver.js';

/**
 * Iterable list of populated relation entities
 *
 * It allows to add / remove objects to relation
 */
export abstract class Relation<R extends ModelBase, O extends ModelBase> extends Array<R> implements IRelation {
  public TargetModelDescriptor: IModelDescriptor;

  protected Orm: Orm;

  public Populated: boolean = false;

  protected Driver: OrmDriver;

  protected IsModelAForwardRef: boolean;

  constructor(protected owner: O, protected Model: Constructor<R> | ForwardRefFunction, protected Relation: IRelationDescriptor, objects?: R[]) {
    super();

    if (objects) {
      this.push(...objects);
    }

    this.TargetModelDescriptor = extractModelDescriptor(Model);
    this.Orm = DI.get(Orm);

    if (this.TargetModelDescriptor) {
      this.Driver = this.Orm.Connections.get(this.TargetModelDescriptor.Connection);
    }

    this.IsModelAForwardRef = !isConstructor(this.Model);
  }

  /**
   * Removes from relation & deletes from db
   *
   * @param obj - data to remove
   */
  public abstract remove(obj: R | R[]): Promise<void>;

  /**
   *
   * Add to relation & saves to db, alias for union, except it can add single element also
   *
   * @param obj - data to add
   */
  public abstract add(obj: R | R[] | Partial<R> | Partial<R>[], mode?: InsertBehaviour): Promise<void>;

  /**
   * Delete all objects from relation
   */
  public async clear(): Promise<void> {
    await this.remove(this);
  }

  public empty() {
    this.length = 0;
  }

  /**
   *
   * Calculates intersection between data in this relation and provided dataset
   * It saves result to db
   *
   * @param dataset - dataset to compare
   * @param callback - function to compare models, if not set it is compared by primary key value
   */
  public abstract intersection(dataset: R[], callback?: (a: R, b: R) => boolean): Promise<void>;

  /**
   * Adds all items to this relation & adds to database
   *
   * @param dataset - data to add
   * @param mode - insert mode
   */
  public abstract union(dataset: R[], mode?: InsertBehaviour): Promise<void>;

  /**
   *
   * Calculates difference between data in this relation and provides set. Result is saved to db.
   *
   * @param dataset - data to compare
   * @param callback - function to compare objects, if none provideded - primary key value is used
   */
  public abstract diff(dataset: R[], callback?: (a: R, b: R) => boolean): Promise<void>;

  /**
   *
   * Clears data and replace it with new dataset.
   *
   * @param dataset - data for replace.
   */
  public abstract set(dataset: R[]): Promise<void>;

  /**
   * Populates this relation ( loads all data related to owner of this relation)
   */
  public async populate(callback?: (this: ISelectQueryBuilder<this>) => void): Promise<void> {
    const query = (this.Relation.TargetModel as any).where(this.Relation.ForeignKey, this.owner.PrimaryKeyValue);
    if (callback) {
      callback.apply(query);
    }
    const result = await query;

    if (result) {
      this.length = 0;
      this.push(...result);
    }

    this.Populated = true;
  }
}

export class SingleRelation<R extends IModelBase> implements IRelation {
  public TargetModelDescriptor: IModelDescriptor;

  protected Orm: Orm;

  public Value: R;

  public Populated: boolean = false;

  constructor(protected _owner: ModelBase, protected model: Constructor<R> | ForwardRefFunction, protected Relation: IRelationDescriptor, object?: R) {
    this.TargetModelDescriptor = extractModelDescriptor(model);
    this.Orm = DI.get(Orm);

    this.Value = object;
  }

  public async set(obj: R) {
    this.Value = obj;
    await this._owner.update();
  }

  public attach(obj: R) {
    this.Value = obj;
  }

  public detach() {
    this.Value = null;
  }

  public async remove() {
    this.Value = null;
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

    const result = await query.firstOrFail();

    if (result) {
      this.Value = result;
    }

    this.Populated = true;
  }
}

export class ManyToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T, O> {
  public intersection(_obj: T[], _callback?: (a: T, b: T) => boolean): Promise<void> {
    throw new Error('Method not implemented.');
  }

  public union(_obj: T[], _mode?: InsertBehaviour): Promise<void> {
    throw new Error('Method not implemented.');
  }

  public diff(_obj: T[], _callback?: (a: T, b: T) => boolean): Promise<void> {
    throw new Error('Method not implemented.');
  }

  public set(_obj: T[], _callback?: (a: T, b: T) => boolean): Promise<void> {
    throw new Error('Method not implemented.');
  }

  public async remove(obj: T | T[]): Promise<void> {
    const self = this;
    const data = (Array.isArray(obj) ? obj : [obj]).map((d) => (d as ModelBase).PrimaryKeyValue);
    const jmodelDescriptor = extractModelDescriptor(this.Relation.JunctionModel);

    const query = this.Driver.del()
      .from(jmodelDescriptor.TableName)
      .where(function () {
        this.whereIn(self.Relation.JunctionModelTargetModelFKey_Name, data);
        this.andWhere(self.Relation.JunctionModelSourceModelFKey_Name, self.owner.PrimaryKeyValue);
      });

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    await query;

    _.remove(this, (o) => data.indexOf(o.PrimaryKeyValue) !== -1);
  }

  public async add(obj: T | T[], mode?: InsertBehaviour): Promise<void> {
    const data = Array.isArray(obj) ? obj : [obj];
    const relEntities = data.map((d) => {
      const relEntity = new this.Relation.JunctionModel();
      (relEntity as any)[this.Relation.JunctionModelSourceModelFKey_Name] = this.owner.PrimaryKeyValue;
      (relEntity as any)[this.Relation.JunctionModelTargetModelFKey_Name] = d.PrimaryKeyValue;

      return relEntity;
    });

    for (const m of relEntities) {
      await m.insert(mode);
    }

    this.push(...data);
  }
}

export class OneToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T, O> {
  /**
   * Deletes from db data that are not in relation
   *
   * @param data relation data
   * @returns
   */
  protected async deleteRelationalData(data: T[]) {
    const query = this.Driver.del().from(this.TargetModelDescriptor.TableName);
    const self = this;

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    // if empty - delete all
    if (data.length === 0) {
      query.where(this.Relation.ForeignKey, this.owner.PrimaryKeyValue);
    } else {

      // delete all that are not in relation
      query.andWhere(function () {
        this.whereNotIn(
          self.Relation.PrimaryKey,
          data.filter((x) => x.PrimaryKeyValue).map((x) => x.PrimaryKeyValue),
        );
        this.where(self.Relation.ForeignKey, self.owner.PrimaryKeyValue);
      });
    }

    await query;
  }

  /**
   *  Synchronizes relation data to db, deletes from db entries that are not in relation and adds entries that are not in db.
   *  Updated models that are dirty
   */
  public async sync() {
    const dirty = this.filter((x) => x.IsDirty || x.PrimaryKeyValue === null);
    for (const f of dirty) {
      await f.insertOrUpdate();
    }

    await this.deleteRelationalData(this);
  }

  public async diff(dataset: T[], callback?: (a: T, b: T) => boolean): Promise<void> {
    // calculate difference between this data in relation and dataset ( objects from this relation)
    const result = callback ? _.differenceWith(dataset, [...this], callback) : _.differenceBy(dataset, [...this], this.TargetModelDescriptor.PrimaryKey);

    // calculate difference between dataset and data in this relation ( objects from dataset )
    const result2 = callback ? _.differenceWith([...this], dataset, callback) : _.differenceBy([...this], dataset, this.TargetModelDescriptor.PrimaryKey);

    // combine difference from two sets
    const finalDiff = [...result, ...result2];

    this.empty();
    this.push(...finalDiff);
    await this.sync();
  }

  public async set(obj: T[]): Promise<void> {
    this.empty();
    this.push(...obj);
    await this.sync();
  }

  public async intersection(obj: T[], callback?: (a: T, b: T) => boolean): Promise<void> {
    const result = callback ? _.intersectionWith(obj, [...this], callback) : _.intersectionBy(obj, [...this], this.TargetModelDescriptor.PrimaryKey);

    this.empty();
    this.push(...result);
    await this.sync();
  }

  /**
   * Combines data with this relation and saves to db
   * Shorthand for push + sync
   * @param obj 
   */
  public async union(obj: T[]): Promise<void> {
    this.push(...obj);
    await this.sync();
  }

  public async remove(obj: T | T[]): Promise<void> {
    const data = (Array.isArray(obj) ? obj : [obj]).map((d) => (d as ModelBase).PrimaryKeyValue);
    _.remove(this, (o) => data.indexOf(o.PrimaryKeyValue) !== -1);
    await this.sync();
  }

  public async add(obj: T | T[] | Partial<T> | Partial<T>[], mode?: InsertBehaviour): Promise<void> {
    const data = Array.isArray(obj) ? obj : [obj];
    const tInsert = data.map((x) => {
      if (x instanceof ModelBase) {
        return x;
      }

      if (this.IsModelAForwardRef) {
        new ((this.Model as Function)())(x);
      }

      return new (this.Model as Constructor<T>)(x);
    }) as T[];

    data.forEach((d) => {
      (d as any)[this.Relation.ForeignKey] = this.owner.PrimaryKeyValue;
    });

    for (const m of tInsert) {
      await m.insertOrUpdate(mode);
    }

    this.push(...tInsert);
  }
}
