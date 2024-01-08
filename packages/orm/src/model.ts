import { ModelData, ModelDataWithRelationData, PartialArray, PickRelations } from './types.js';
/* eslint-disable prettier/prettier */
import { SortOrder } from './enums.js';
import { MODEL_DESCTRIPTION_SYMBOL } from './decorators.js';
import { IModelDescriptor, RelationType, InsertBehaviour, IUpdateResult, IOrderByBuilder, ISelectQueryBuilder, IWhereBuilder, QueryScope, IHistoricalModel, ModelToSqlConverter, ObjectToSqlConverter, IModelBase, IRelationDescriptor } from './interfaces.js';
import { WhereFunction } from './types.js';
import { RawQuery, UpdateQueryBuilder, TruncateTableQueryBuilder, QueryBuilder, SelectQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder } from './builders.js';
import { Op } from './enums.js';
import { DI, isConstructor, Class, IContainer } from '@spinajs/di';
import { Orm } from './orm.js';
import { ModelHydrator } from './hydrators.js';
import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { OrmException } from './exceptions.js';
import { StandardModelDehydrator, StandardModelWithRelationsDehydrator } from './dehydrators.js';
import { Wrap } from './statements.js';
import { DateTime } from 'luxon';
import { OrmDriver } from './driver.js';
import { ManyToManyRelationList, OneToManyRelationList, Relation, SingleRelation } from './relation-objects.js';
import { DiscriminationMapMiddleware } from './middlewares.js';

export function extractModelDescriptor(targetOrForward: any): IModelDescriptor {
  const target = !isConstructor(targetOrForward) && targetOrForward ? targetOrForward() : targetOrForward;

  if (!target) {
    return null;
  }

  let descriptor: any = null;
  _reduce(target);
  return descriptor;

  function _reduce(t: any) {
    if (!t) {
      return;
    }

    if (t[MODEL_DESCTRIPTION_SYMBOL]) {
      descriptor = descriptor ?? {};

      _.mergeWith(descriptor, t[MODEL_DESCTRIPTION_SYMBOL], (a: any, b: any) => {
        if (!a) {
          return b;
        }

        if (Array.isArray(a)) {
          return a.concat(b);
        }

        return a;
      });
    }

    _reduce(t.prototype);
    _reduce(t.__proto__);
  }
}

export class ModelBase<M = unknown> implements IModelBase {
  private _container: IContainer;

  /**
   * List of hidden properties from JSON / dehydrations
   * eg. password field of user
   */
  protected _hidden: string[] = [];

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
      const orm = DI.get<Orm>(Orm);
      const driver = orm.Connections.get(this.ModelDescriptor.Connection);

      if (!driver) {
        throw new Error(`model ${this.constructor.name} have invalid connection ${this.ModelDescriptor.Connection}, please check your db config file or model connection name`);
      }

      this._container = driver.Container;
    }

    return this._container;
  }

  public get PrimaryKeyName() {
    return this.ModelDescriptor.PrimaryKey;
  }

  public get PrimaryKeyValue() {
    return (this as any)[this.PrimaryKeyName];
  }

  public set PrimaryKeyValue(newVal: any) {
    (this as any)[this.PrimaryKeyName] = newVal;

    this.ModelDescriptor.Relations.forEach((r) => {
      const rel = (this as any)[r.Name];
      if (!rel) return;

      switch (r.Type) {
        case RelationType.One:
          (rel as any)[r.ForeignKey] = newVal;
          break;
        case RelationType.Many:
          (rel as any[]).forEach((rVal) => (rVal[r.ForeignKey] = newVal));
          break;
        case RelationType.ManyToMany:
          // TODO: rethink this
          break;
      }
    });
  }

  public valueOf() {
    return this.PrimaryKeyValue;
  }

  public driver(): OrmDriver {
    const orm = DI.get<Orm>(Orm);
    const driver = orm.Connections.get(this.ModelDescriptor.Connection);
    return driver;
  }

  /**
   * Recursivelly takes all relation data and returns as single array
   */
  public getFlattenRelationModels(recursive?: boolean): ModelBase[] {
    const reduceRelations = function (m: ModelBase): ModelBase[] {
      const relations = [...m.ModelDescriptor.Relations.values()];
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

  public static getModelDescriptor() {
    throw new Error('Not implemented');
  }

  public static getRelationDescriptor(_relation: string) {
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
  public static getOrNew<T extends typeof ModelBase>(this: T, _pk?: any, _data?: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
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
   *
   * Checks if model with pk key / unique fields exists and if not creates one and saves to db
   * NOTE: it checks for unique fields too.
   *
   * @param data - model width data to check
   */
  public static getOrCreate<T extends typeof ModelBase>(this: T, _pk: any, _data?: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
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

  public static whereExists<T extends typeof ModelBase>(this: T, _query: ISelectQueryBuilder<T>): ISelectQueryBuilder<Array<InstanceType<T>>> {
    throw new Error('Not implemented');
  }

  public static whereNotExists<T extends typeof ModelBase>(this: T, _query: ISelectQueryBuilder<T>): ISelectQueryBuilder<Array<InstanceType<T>>> {
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
    for (const [_, v] of this.ModelDescriptor.Relations.entries()) {
      if (v.TargetModel.name === (data as any).constructor.name) {
        // TODO: refactor this, so we dont update foreign key
        // instead we must use belongsTo relation on data model to update
        (data as any)[v.ForeignKey] = this.PrimaryKeyValue;

        switch (v.Type) {
          case RelationType.One:
            ((this as any)[v.Name] as SingleRelation<ModelBase>).attach(data);
            break;
          case RelationType.Many:
          case RelationType.ManyToMany:
            ((this as any)[v.Name] as Relation<ModelBase, ModelBase>).push(data);
            break;
        }
      }
    }
  }

  /**
   * Extracts all data from model. It takes only properties that exists in DB
   */
  public dehydrate(omit?: string[]): ModelData<this> {
    return this.Container.resolve(StandardModelDehydrator).dehydrate(this, [...(omit ?? []), ...this._hidden]) as ModelData<this>;
  }

  /**
   *
   * Extracts all data from model with relation data. Relation data are dehydrated recursively.
   *
   * @param omit - fields to omit
   */
  dehydrateWithRelations(omit?: string[]): ModelDataWithRelationData<this> {
    return this.Container.resolve(StandardModelWithRelationsDehydrator).dehydrate(this, [...(omit ?? []), ...this._hidden]) as ModelDataWithRelationData<this>;
  }

  public toSql(): Partial<this> {
    return this.Container.resolve(ModelToSqlConverter).toSql(this) as Partial<this>;
  }

  /**
   * deletes enitt from db. If model have SoftDelete decorator, model is marked as deleted
   */
  public async destroy() {
    if (!this.PrimaryKeyValue) {
      return;
    }
    await (this.constructor as any).destroy(this.PrimaryKeyValue);
  }

  /**
   * If model can be in achived state - sets archived at date and saves it to db
   */
  public async archive() {
    if (this.ModelDescriptor.Archived) {
      (this as any)[this.ModelDescriptor.Archived.ArchivedAt] = DateTime.now();
    } else {
      throw new OrmException('archived at column not exists in model');
    }

    const { query } = this.createUpdateQuery();
    await query.update(this.toSql()).where(this.PrimaryKeyName, this.PrimaryKeyValue);
  }

  public async update() {
    const { query } = this.createUpdateQuery();

    if (this.ModelDescriptor.Timestamps.UpdatedAt) {
      (this as any)[this.ModelDescriptor.Timestamps.UpdatedAt] = DateTime.now();
    }

    await query.update(this.toSql()).where(this.PrimaryKeyName, this.PrimaryKeyValue);
  }

  /**
   * Save all changes to db. It creates new entry id db or updates existing one if
   * primary key exists
   */
  public async insert(insertBehaviour: InsertBehaviour = InsertBehaviour.None) {
    const { query, description } = this.createInsertQuery();

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

    const iMidleware = {
      afterQuery: (data: IUpdateResult) => {
        this.PrimaryKeyValue = this.PrimaryKeyValue ?? data.LastInsertId;
        return data;
      },
      modelCreation: (): any => null,
      afterHydration: (): any => null,
    };

    query.middleware(iMidleware);

    return query.values(this.toSql());
  }

  /**
   *
   * Shorthand for inserting model when no primary key exists, or update
   * its value in db if primary key is set
   *
   * @param insertBehaviour - insert mode
   */
  public async insertOrUpdate(insertBehaviour: InsertBehaviour = InsertBehaviour.None) {
    if (this.PrimaryKeyValue) {
      await this.update();
    } else {
      await this.insert(insertBehaviour);
    }
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
    let model: this = null;

    model = await this.fresh();

    for (const c of this.ModelDescriptor.Columns) {
      (this as any)[c.Name] = (model as any)[c.Name];
    }
  }

  public toJSON() {
    return this.dehydrate();
  }

  /**
   * sets default values for model. values are taken from DB default column prop
   */
  protected setDefaults() {
    this.ModelDescriptor.Columns?.forEach((c) => {
      if (c.Uuid) {
        (this as any)[c.Name] = uuidv4();
      } else {
        (this as any)[c.Name] = c.DefaultValue;
      }
    });

    if (this.ModelDescriptor.Timestamps.CreatedAt) {
      (this as any)[this.ModelDescriptor.Timestamps.CreatedAt] = DateTime.now();
    }

    for (const [, rel] of this.ModelDescriptor.Relations) {
      if (rel.Factory) {
        (this as any)[rel.Name] = rel.Factory(this, rel, this.Container);
      } else if (rel.RelationClass) {
        (this as any)[rel.Name] = this.Container.resolve(rel.RelationClass, [this, rel.TargetModel, rel, []]);
      } else if (rel.Type === RelationType.Many) {
        (this as any)[rel.Name] = new OneToManyRelationList(this, rel.TargetModel, rel, []);
      } else if (rel.Type === RelationType.ManyToMany) {
        (this as any)[rel.Name] = new ManyToManyRelationList(this, rel.TargetModel, rel, []);
      } else {
        (this as any)[rel.Name] = new SingleRelation(this, rel.TargetModel, rel, null);
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

function _descriptor(model: Class<any>) {
  return (model as any)[MODEL_DESCTRIPTION_SYMBOL] as IModelDescriptor;
}

function _preparePkWhere(description: IModelDescriptor, query: ISelectQueryBuilder<any>, model: ModelBase) {
  if (description.PrimaryKey) {
    query.where(description.PrimaryKey, model.PrimaryKeyValue);
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
  if (description.PrimaryKey) {
    query.order(description.PrimaryKey, order ?? SortOrder.DESC);
  } else {
    const unique = description.Columns.filter((c) => c.Unique);
    if (unique.length !== 0) {
      unique.forEach((c) => query.order(c.Name, order ?? SortOrder.DESC));
    } else if (description.Timestamps?.CreatedAt) {
      query.order(description.Timestamps.CreatedAt, order ?? SortOrder.DESC);
    } else if (description.Timestamps?.UpdatedAt) {
      query.order(description.Timestamps.UpdatedAt, order ?? SortOrder.DESC);
    }
  }
}

export abstract class HistoricalModel implements IHistoricalModel {
  public readonly __action__: 'update' | 'insert' | 'delete';
  public readonly __revision__: number;
  public readonly __start__: DateTime;
  public readonly __end__: DateTime;
}

/**
 * Helper function to create query based on model
 *
 * @param model - source model for query
 * @param query - query class
 * @param injectModel - should inject model information into query, if not, query will return raw data
 *
 * @returns
 */
export function createQuery<T extends QueryBuilder>(model: Class<any>, query: Class<T>, injectModel = true) {
  const dsc = _descriptor(model);

  if (!dsc) {
    throw new Error(`model ${model.name} does not have model descriptor. Use @model decorator on class`);
  }

  const orm = DI.get<Orm>(Orm);
  const driver = orm.Connections.get(dsc.Connection);

  if (!driver) {
    throw new Error(`model ${model.name} have invalid connection ${dsc.Connection}, please check your db config file or model connection name`);
  }

  const cnt = driver.Container;
  const qr = cnt.resolve<T>(query, [driver, injectModel ? orm.Models.find((x) => x.name === model.name).type : null]);

  if (qr instanceof SelectQueryBuilder) {
    const scope = (model as any)._queryScopes as QueryScope;
    if (scope) {
      Object.getOwnPropertyNames((scope as any).__proto__)
        .filter((x) => x !== 'constructor')
        .forEach(function (property) {
          if (typeof (scope as any)[property] === 'function') {
            (qr as any)[property] = (scope as any)[property].bind(qr);
          }
        });
    }
  }

  qr.middleware(new DiscriminationMapMiddleware(dsc));
  qr.setTable(dsc.TableName);

  if (driver.Options.Database) {
    qr.database(driver.Options.Database);
  }

  return {
    query: qr,
    description: dsc,
    model,
    container: driver.Container,
  };
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
    const orm = DI.get<Orm>(Orm);
    const driver = orm.Connections.get(dsc.Connection);

    if (!driver) {
      throw new Error(`model ${this.name} have invalid connection ${dsc.Connection}, please check your db config file or model connection name`);
    }

    return driver;
  },

  query(): SelectQueryBuilder {
    const { query } = createQuery(this, SelectQueryBuilder);
    return query;
  },

  where(column: string | boolean | WhereFunction<any> | RawQuery | Wrap | {}, operator?: Op | any, value?: any): SelectQueryBuilder {
    const { query } = createQuery(this, SelectQueryBuilder);
    query.select('*');

    return query.where(column, operator, value);
  },

  update<T extends typeof ModelBase>(data: Partial<InstanceType<T>>) {
    const { query } = createQuery(this, UpdateQueryBuilder);
    return query.update(data);
  },

  all(page?: number, perPage?: number) {
    const { query } = createQuery(this, SelectQueryBuilder);

    query.select('*');
    if (page >= 0 && perPage > 0) {
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

    if (Array.isArray(data)) {
      if (insertBehaviour !== InsertBehaviour.None) {
        throw new OrmException(`insert behaviour is not supported with arrays`);
      }

      query.values(
        (data as Array<InstanceType<T>>).map((d) => {
          if (d instanceof ModelBase) {
            return d.toSql();
          }
          return converter.toSql(d);
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

      if (data instanceof ModelBase) {
        query.values(data.toSql());
      } else {
        query.values(converter.toSql(data));
      }
    }

    const iMidleware = {
      afterQuery: (result: IUpdateResult) => {
        if (Array.isArray(data)) {
          (data as Array<InstanceType<T>>).forEach((v, idx) => {
            if (v instanceof ModelBase) {
              v.PrimaryKeyValue = v.PrimaryKeyValue ?? result.LastInsertId - data.length + idx + 1;
            }
          });
        } else if (data instanceof ModelBase) {
          (data as InstanceType<T>).PrimaryKeyValue = (data as InstanceType<T>).PrimaryKeyValue ?? result.LastInsertId;
        }

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
    const pkey = description.PrimaryKey;
    query.select('*');
    query.whereIn(pkey, pks);
    return await (query as SelectQueryBuilder<Array<InstanceType<T>>>);
  },

  async findOrFail<T extends typeof ModelBase>(this: T, pks: any[]): Promise<Array<InstanceType<T>>> {
    const { query, description, model } = createQuery(this as any, SelectQueryBuilder);
    const pkey = description.PrimaryKey;

    query.select('*');
    query.whereIn(pkey, pks);

    const result = await (query as SelectQueryBuilder<Array<InstanceType<T>>>);

    if (result.length !== pks.length) {
      throw new Error(`could not find all results for model ${model.name}`);
    }

    return result;
  },

  async get<T extends typeof ModelBase>(this: T, pk: any): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);
    const pkey = description.PrimaryKey;

    query.select('*');
    query.where(pkey, pk);

    _prepareOrderBy(description, query);

    return (await query.first()) as unknown as Promise<InstanceType<T>>;
  },

  async getOrFail<T extends typeof ModelBase>(this: T, pk: any): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);
    const pkey = description.PrimaryKey;

    query.select('*');
    query.where(pkey, pk);

    _prepareOrderBy(description, query);

    return (await query.firstOrFail()) as unknown as Promise<InstanceType<T>>;
  },

  destroy<T extends typeof ModelBase>(pks?: any | any[]): IWhereBuilder<InstanceType<T>> {
    const description = _descriptor(this);

    const data = Array.isArray(pks) ? pks : [pks];

    const { query } = description.SoftDelete?.DeletedAt ? createQuery(this, UpdateQueryBuilder) : createQuery(this, DeleteQueryBuilder);

    if (description.SoftDelete?.DeletedAt) {
      (query as UpdateQueryBuilder<never>).update({
        [description.SoftDelete.DeletedAt]: DateTime.now(),
      });
    }

    if (pks) {
      query.whereIn(description.PrimaryKey, data);
    }

    return query;
  },

  async create<T extends typeof ModelBase>(this: T, data: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const entity = new (Function.prototype.bind.apply(this))(data);
    await (entity as ModelBase).insert();
    return entity;
  },

  async getOrCreate<T extends typeof ModelBase>(this: T, pk: any, data: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);

    // pk constrain
    if (description.PrimaryKey && pk !== null) {
      query.where(description.PrimaryKey, pk);
    }

    // check for all unique columns ( unique constrain )
    description.Columns.filter((c) => c.Unique).forEach((c) => {
      query.andWhere(c, (data as any)[c.Name]);
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

  async getOrNew<T extends typeof ModelBase>(this: T, pk: any, data?: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);

    // pk constrain
    if (description.PrimaryKey) {
      query.where(description.PrimaryKey, pk);
    }

    // check for all unique columns ( unique constrain )
    description.Columns.filter((c) => c.Unique).forEach((c) => {
      query.andWhere(c, (data as any)[c.Name]);
    });

    _prepareOrderBy(description, query);

    let entity = (await query.first()) as any;

    if (!entity) {
      entity = new (Function.prototype.bind.apply(this))(data);
      return entity;
    }

    return entity;
  },

  async exists<T extends typeof ModelBase>(this: T, pk: any) {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);
    // pk constrain
    if (description.PrimaryKey && pk !== null) {
      query.where(description.PrimaryKey, pk);
    }

    const result = await query.clearColumns().select(description.PrimaryKey).first();
    if (result) {
      return true;
    }

    return false;
  },

  async whereExists<T extends typeof ModelBase, Z extends ModelBase<unknown> | ModelBase<unknown>[]>(this: T, q: ISelectQueryBuilder<Z>) {
    const { query } = createQuery(this as any, SelectQueryBuilder);
    query.whereExist(q);
    return await query;
  },

  async whereNotExists<T extends typeof ModelBase, Z extends ModelBase<unknown> | ModelBase<unknown>[]>(this: T, q: ISelectQueryBuilder<Z>) {
    const { query } = createQuery(this as any, SelectQueryBuilder);
    query.whereNotExists(q);
    return await query;
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

    return await (
      await query.asRaw<{ count: number }>()
    ).count;
  },
};
