/* eslint-disable prettier/prettier */
import { InvalidOperation } from '@spinajs/exceptions';
import { IRelationDescriptor, IModelDescriptor, RelationType, InsertBehaviour, ForwardRefFunction, IBuilderMiddleware } from './interfaces.js';
import { NewInstance, DI, Constructor, isConstructor } from '@spinajs/di';
import { SelectQueryBuilder } from './builders.js';
import { createQuery, extractModelDescriptor, ModelBase } from './model.js';
import { IModelBase } from "./interfaces.js";
import { Orm } from './orm.js';
import { OrmDriver } from './driver.js';
import _ from 'lodash';

export interface IOrmRelation {
  /**
   * Executes relation, should be called only once.
   *
   * @param callback - optional callback to perform actions on relations eg. populate more, filter relational data etc.
   */
  execute(callback?: (this: SelectQueryBuilder, relation: OrmRelation) => void): void;

  /**
   * Execute actions on relation query, does not initialize relation. Use it only AFTER execute was called.
   *
   * @param callback - execute callback to perform actions on relations eg. populate more, filter relational data etc.
   */
  executeOnQuery(callback: (this: SelectQueryBuilder, relation: OrmRelation) => void): void;

  /**
   * Relation name
   */
  Name: string;
}

export abstract class OrmRelation implements IOrmRelation {
  protected _targetModel: Constructor<ModelBase> | ForwardRefFunction;
  protected _targetModelDescriptor: IModelDescriptor;
  protected _relationQuery: SelectQueryBuilder;
  protected _separator: string;

  public Name: string;

  get Alias(): string {
    return this.parentRelation ? `${this.parentRelation.Alias}.${this._separator}${this._description.Name}${this._separator}` : `${this._separator}${this._description.Name}${this._separator}`;
  }

  constructor(protected _orm: Orm, protected _query: SelectQueryBuilder<any>, public _description: IRelationDescriptor, public parentRelation?: OrmRelation) {
    if (this._description) {
      this._targetModel = this._description.TargetModel ?? undefined;
    }

    this._targetModelDescriptor = extractModelDescriptor(this._targetModel);

    const driver = this._orm.Connections.get(this._targetModelDescriptor.Connection);
    const cnt = driver.Container;
    this._relationQuery = cnt.resolve<SelectQueryBuilder>(SelectQueryBuilder, [driver, this._targetModel, this]);
    this._separator = driver.Options.AliasSeparator;

    if (driver.Options.Database) {
      this._relationQuery.database(driver.Options.Database);
    }
  }

  public abstract execute(callback?: (this: SelectQueryBuilder, relation: OrmRelation) => void): void;

  public executeOnQuery(callback: (this: SelectQueryBuilder<any>, relation: OrmRelation) => void): void {
    callback.call(this._relationQuery, [this]);
  }
}

class HasManyRelationMiddleware implements IBuilderMiddleware {
  constructor(protected _relationQuery: SelectQueryBuilder, protected _description: IRelationDescriptor, protected _path: string) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(_: any): ModelBase {
    return null;
  }

  public async afterHydration(data: ModelBase[]): Promise<any[]> {
    const self = this;
    const pks = data.map((d: any) => {
      return d[this._description.PrimaryKey];
    });

    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data;
      },
      modelCreation(): ModelBase {
        return null;
      },
      async afterHydration(relationData: ModelBase[]) {
        relationData.forEach((d) => ((d as any).__relationKey__ = self._description.Name));
        data.forEach((d: any) => {
          const relData = relationData.filter((rd) => {
            return d[self._description.PrimaryKey] === (rd as any)[self._description.ForeignKey];
          });

          d[self._description.Name] = new OneToManyRelationList(d, self._description.TargetModel, self._description, relData);
        });
      },
    };

    if (pks.length !== 0) {
      this._relationQuery.whereIn(this._description.ForeignKey, pks);
      this._relationQuery.middleware(hydrateMiddleware);
      return await this._relationQuery;
    }

    return [];
  }
}

class BelongsToRelationRecursiveMiddleware implements IBuilderMiddleware {
  constructor(protected _relationQuery: SelectQueryBuilder, protected _description: IRelationDescriptor, protected _targetModelDescriptor: IModelDescriptor) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(_: any): ModelBase {
    return null;
  }

  public async afterHydration(data: ModelBase[]): Promise<any[]> {
    const self = this;
    const pks = data.map((d) => (d as any)[this._description.PrimaryKey]);
    const fKey = this._description.ForeignKey;
    const key = this._description.PrimaryKey;
    const name = this._description.Name;

    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data;
      },
      modelCreation(_: any): ModelBase {
        return null;
      },
      async afterHydration(relationData: ModelBase[]) {
        relationData.forEach((d) => ((d as any).__relationKey__ = self._description.Name));

        function buildRelationTree(_d: any[], parent?: any): unknown[] {
          const branch: unknown[] = [];

          _d.forEach((d) => {
            if (d[fKey] === parent) {
              const children = buildRelationTree(_d, d[key]);
              if (children) {
                // TODO:
                // implement RecursiveRelation list to allow for
                // manipulation of the recursive data
                d[name] = new OneToManyRelationList(
                  d,
                  d.Model,
                  {
                    Name: name,
                    Type: RelationType.Many,
                    TargetModelType: d.Model,
                    TargetModel: d.Model,
                    SourceModel: d.Model,
                    ForeignKey: fKey,
                    PrimaryKey: key,
                    Recursive: false,
                  },
                  children as ModelBase<unknown>[],
                );
              }
              branch.push(d);
            }
          });
          return branch;
        }

        const result = buildRelationTree(relationData, null);
        data.forEach((d : any) => {
          d[name] = (result.find((r : any) => r[key] === d[key]) as any )[name];
        });
        console.log("da");
      },
    };

    this._relationQuery.whereIn(this._description.PrimaryKey, pks);
    this._relationQuery.middleware(new DiscriminationMapMiddleware(this._targetModelDescriptor));
    this._relationQuery.middleware(hydrateMiddleware);
    return await this._relationQuery;
  }
}

class HasManyToManyRelationMiddleware implements IBuilderMiddleware {
  constructor(protected _relationQuery: SelectQueryBuilder, protected _description: IRelationDescriptor, protected _targetModelDescriptor: IModelDescriptor) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(_: any): ModelBase {
    return null;
  }

  public async afterHydration(data: ModelBase[]): Promise<any[]> {
    const self = this;
    const pks = data.map((d) => (d as any)[this._description.PrimaryKey]);
    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data.map((d) => Object.assign({}, d[self._description.Name], { JunctionModel: self.pickProps(d, [self._description.Name]) }));
      },
      modelCreation(_: any): ModelBase {
        return null;
      },
      async afterHydration(relationData: ModelBase[]) {
        relationData.forEach((d) => ((d as any).__relationKey__ = self._description.Name));

        data.forEach((d) => {
          const relData = relationData.filter((rd) => (rd as any).JunctionModel[self._description.ForeignKey] === (d as any)[self._description.PrimaryKey]);
          (d as any)[self._description.Name] = new ManyToManyRelationList(d, self._description.TargetModel, self._description, relData);
        });

        relationData.forEach((d) => delete (d as any).JunctionModel);
      },
    };

    if (pks.length !== 0) {
      this._relationQuery.whereIn(this._description.ForeignKey, pks);
      this._relationQuery.middleware(new BelongsToRelationResultTransformMiddleware(this._description, null));
      this._relationQuery.middleware(new DiscriminationMapMiddleware(this._targetModelDescriptor));
      this._relationQuery.middleware(hydrateMiddleware);
      return await this._relationQuery;
    }

    return [];
  }

  private pickProps(source: any, except: string[]) {
    const obj: any = {};
    for (const p in source) {
      if (except.indexOf(p) === -1) {
        obj[p] = source[p];
      }
    }

    return obj;
  }
}

class BelongsToPopulateDataMiddleware implements IBuilderMiddleware {
  constructor(protected _description: IRelationDescriptor, protected relation: BelongsToRelation) {}

  afterQuery(data: any[]): any[] {
    return data;
  }
  modelCreation(_: any): ModelBase<unknown> {
    return null;
  }
  afterHydration(data: ModelBase<unknown>[]): Promise<void | any[]> {
    const relData = data.map((d: any) => d[this._description.Name as any].Value).filter((x) => x !== null);
    const middlewares = ((this.relation as any)._relationQuery.Relations as any[])
      .map((x) => {
        return x._query._middlewares;
      })
      .reduce((prev, current) => {
        return prev.concat(current);
      }, []);
    return Promise.all(
      middlewares.map((x: any) => {
        return x.afterHydration(relData);
      }),
    );
  }
}

class BelongsToRelationResultTransformMiddleware implements IBuilderMiddleware {
  constructor(protected _description: IRelationDescriptor, protected relation: BelongsToRelation) {}

  public afterQuery(data: any[]): any[] {
    return data.map((d) => {
      const transformedData = Object.assign(d);
      for (const key in transformedData) {
        if (key.startsWith('$')) {
          this.setDeep(transformedData, this.keyTransform(key), d[key]);
          delete transformedData[key];
        }
      }

      return transformedData;
    });
  }

  public modelCreation(_: any): ModelBase {
    return null;
  }

  // tslint:disable-next-line: no-empty
  public async afterHydration(_data: Array<ModelBase>) {}

  /**
   * Dynamically sets a deeply nested value in an object.
   * Optionally "bores" a path to it if its undefined.
   *
   * @param obj  - The object which contains the value you want to change/set.
   * @param path  - The array representation of path to the value you want to change/set.
   * @param value - The value you want to set it to.
   * @param setrecursively - If true, will set value of non-existing path as well.
   */
  protected setDeep(obj: any, path: any[], value: any, setrecursively = true) {
    path.reduce((a, b, level) => {
      if (setrecursively && typeof a[b] === 'undefined' && level !== path.length - 1) {
        a[b] = {};
        return a[b];
      }

      if (level === path.length - 1) {
        a[b] = value;
        return value;
      }
      return a[b];
    }, obj);
  }

  protected keyTransform(key: string) {
    return key.replace(/\$+/g, '').split('.');
  }
}

export class DiscriminationMapMiddleware implements IBuilderMiddleware {
  constructor(protected _description: IModelDescriptor) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(data: any): ModelBase {
    if (this._description.DiscriminationMap && this._description.DiscriminationMap.Field) {
      const distValue = data[this._description.DiscriminationMap.Field];
      if (distValue && this._description.DiscriminationMap.Models.has(distValue)) {
        const result = new (this._description.DiscriminationMap.Models.get(distValue) as any)();
        result.hydrate(data);

        return result;
      }
    }

    return null;
  }

  // tslint:disable-next-line: no-empty
  public async afterHydration(_data: ModelBase[]) {}
}

@NewInstance()
export class BelongsToRelation extends OrmRelation {
  constructor(_orm: Orm, _query: SelectQueryBuilder<any>, _description: IRelationDescriptor, _parentRelation?: OrmRelation) {
    super(_orm, _query, _description, _parentRelation);

    this._relationQuery.from(this._targetModelDescriptor.TableName, this.Alias);
    this._targetModelDescriptor.Columns.forEach((c) => {
      this._relationQuery.select(c.Name, `${this.Alias}.${c.Name}`);
    });
  }

  public execute(callback: (this: SelectQueryBuilder, relation: OrmRelation) => void) {
    if (!this.parentRelation && !this._query.TableAlias) {
      this._query.setAlias(`${this._separator}${this._description.SourceModel.name}${this._separator}`);
    }

    this._query.leftJoin(this._targetModelDescriptor.TableName, this.Alias, this._description.ForeignKey, `${this._description.PrimaryKey}`);

    if (callback) {
      callback.call(this._relationQuery, [this]);
    }

    this._query.mergeBuilder(this._relationQuery);

    this._query.middleware(new BelongsToPopulateDataMiddleware(this._description, this));
    if (!this.parentRelation) {
      // if we are on top of the belongsTo relation stack
      // add transform middleware
      // we do this becouse belongsTo modifies query (not creating new like oneToMany and manyToMany)
      // and we only need to run transform once
      this._query.middleware(new BelongsToRelationResultTransformMiddleware(this._description, this));
    }
  }
}

@NewInstance()
export class BelongsToRecursiveRelation extends OrmRelation {
  constructor(_orm: Orm, _query: SelectQueryBuilder<any>, _description: IRelationDescriptor, _parentRelation?: OrmRelation) {
    super(_orm, _query, _description, _parentRelation);

    this._relationQuery.withRecursive(this._description.ForeignKey, this._description.PrimaryKey).from(this._targetModelDescriptor.TableName, this.Alias);
    this._targetModelDescriptor.Columns.forEach((c) => {
      this._relationQuery.select(c.Name, `${this.Alias}.${c.Name}`);
    });
  }

  public execute(callback: (this: SelectQueryBuilder, relation: OrmRelation) => void) {
    if (callback) {
      callback.call(this._relationQuery, [this]);
    }

    this._query.middleware(new BelongsToRelationRecursiveMiddleware(this._relationQuery, this._description, this._targetModelDescriptor));
  }
}

@NewInstance()
export class OneToManyRelation extends OrmRelation {
  constructor(_orm: Orm, _query: SelectQueryBuilder<any>, _description: IRelationDescriptor, _parentRelation?: OrmRelation) {
    super(_orm, _query, _description, _parentRelation);

    this._relationQuery.from(this._targetModelDescriptor.TableName, this.Alias);
    this._relationQuery.columns(
      this._targetModelDescriptor.Columns.map((c) => {
        return c.Name;
      }),
    );
  }

  public execute(callback?: (this: SelectQueryBuilder<any>, relation: OrmRelation) => void): void {
    if (!this.parentRelation && !this._query.TableAlias) {
      this._query.setAlias(`${this._separator}${this._description.SourceModel.name}${this._separator}`);
    }

    if (callback) {
      callback.call(this._relationQuery, [this]);
    }

    this._query.middleware(new DiscriminationMapMiddleware(this._targetModelDescriptor));
    this._query.middleware(new HasManyRelationMiddleware(this._relationQuery, this._description, null));
  }
}

@NewInstance()
export class ManyToManyRelation extends OrmRelation {
  protected _joinModel: Constructor<ModelBase>;
  protected _joinModelDescriptor: IModelDescriptor;
  protected _joinQuery: SelectQueryBuilder;

  public get TableJoinQuery() {
    return this._joinQuery;
  }

  public get RelationQuery() {
    return this._relationQuery;
  }

  constructor(_orm: Orm, _query: SelectQueryBuilder<any>, _description: IRelationDescriptor, _parentRelation?: OrmRelation) {
    super(_orm, _query, _description, _parentRelation);

    this._joinModel = this._orm.Models.find((m) => m.name === this._description.JunctionModel?.name)?.type ?? undefined;

    if (this._joinModel === undefined) {
      throw new InvalidOperation(`model ${this._description.JunctionModel} not exists in orm module`);
    }

    this._joinModelDescriptor = extractModelDescriptor(this._joinModel);

    const orm = DI.get<Orm>(Orm);
    const driver = orm.Connections.get(this._targetModelDescriptor.Connection);

    const cnt = driver.Container;
    this._joinQuery = cnt.resolve<SelectQueryBuilder>(SelectQueryBuilder, [driver, this._targetModel, this]);

    if (driver.Options.Database) {
      this._joinQuery.database(driver.Options.Database);
    }

    this._joinQuery.from(this._joinModelDescriptor.TableName, `${this._separator}${this._joinModelDescriptor.TableName}${this._separator}`);
    this._joinQuery.columns(
      this._joinModelDescriptor.Columns.map((c) => {
        return c.Name;
      }),
    );

    this._relationQuery.from(this._targetModelDescriptor.TableName, this.Alias);
    this._targetModelDescriptor.Columns.forEach((c) => {
      this._relationQuery.select(c.Name, `${this.Alias}.${c.Name}`);
    });
  }

  public execute(callback?: (this: SelectQueryBuilder<any>, relation: OrmRelation) => void): void {
    this._joinQuery.leftJoin(this._targetModelDescriptor.TableName, this.Alias, this._description.JunctionModelTargetModelFKey_Name, this._description.ForeignKey);

    if (callback) {
      callback.call(this._relationQuery, [this]);
    }

    const joinRelationDescriptor = {
      Name: this._description.Name,
      Type: RelationType.Many,
      TargetModelType: this._description.JunctionModel,
      TargetModel: this._description.JunctionModel as any,
      SourceModel: this._description.SourceModel as any,
      ForeignKey: this._description.JunctionModelSourceModelFKey_Name,
      PrimaryKey: this._description.PrimaryKey,
      Recursive: false,
    };

    this._joinQuery.mergeBuilder(this._relationQuery);

    this._query.middleware(new HasManyToManyRelationMiddleware(this._joinQuery, joinRelationDescriptor, this._targetModelDescriptor));
  }
}

export interface IRelation {
  TargetModelDescriptor: IModelDescriptor;

  /**
   * Indicates if data was fetched  from db
   */
  Populated: boolean;
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
  public async populate(callback?: (this: SelectQueryBuilder<this>) => void): Promise<void> {
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
  protected async deleteRelationData(data: T[]) {
    if (data.length === 0) {
      return;
    }

    const self = this;

    const query = this.Driver.del()
      .from(this.TargetModelDescriptor.TableName)
      .andWhere(function () {
        this.whereNotIn(
          self.Relation.PrimaryKey,
          data.filter((x) => x.PrimaryKeyValue).map((x) => x.PrimaryKeyValue),
        );
        this.where(self.Relation.ForeignKey, self.owner.PrimaryKeyValue);
      });

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    await query;

    this.empty();
  }

  public async diff(dataset: T[], callback?: (a: T, b: T) => boolean): Promise<void> {
    // calculate difference between this data in relation and dataset ( objects from this relation)
    const result = callback ? _.differenceWith(dataset, [...this], callback) : _.differenceBy(dataset, [...this], this.TargetModelDescriptor.PrimaryKey);

    // calculate difference between dataset and data in this relation ( objects from dataset )
    const result2 = callback ? _.differenceWith([...this], dataset, callback) : _.differenceBy([...this], dataset, this.TargetModelDescriptor.PrimaryKey);

    // combine difference from two sets
    const finalDiff = [...result, ...result2];

    await this.deleteRelationData(finalDiff);
    await this.add(finalDiff, InsertBehaviour.InsertOrUpdate);
  }

  public async set(obj: T[]): Promise<void> {
    await this.deleteRelationData(obj);
    await this.add(obj, InsertBehaviour.InsertOrUpdate);
  }

  public async intersection(obj: T[], callback?: (a: T, b: T) => boolean): Promise<void> {
    const result = callback ? _.intersectionWith(obj, [...this], callback) : _.intersectionBy(obj, [...this], this.TargetModelDescriptor.PrimaryKey);
    await this.deleteRelationData(result);
    await this.add(result, InsertBehaviour.InsertOrUpdate);
  }

  public async union(obj: T[], mode?: InsertBehaviour): Promise<void> {
    await this.add(obj, mode ?? InsertBehaviour.InsertOrIgnore);
  }

  public async remove(obj: T | T[]): Promise<void> {
    const data = (Array.isArray(obj) ? obj : [obj]).map((d) => (d as ModelBase).PrimaryKeyValue);

    const query = this.Driver.del().whereIn(this.Relation.ForeignKey, data).setTable(this.TargetModelDescriptor.TableName);

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    await query;

    _.remove(this, (o) => data.indexOf(o.PrimaryKeyValue) !== -1);
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
