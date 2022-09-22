/* eslint-disable prettier/prettier */
import { DiscriminationMapMiddleware, OneToManyRelationList, ManyToManyRelationList, Relation, SingleRelation } from './relations';
import { SordOrder } from './enums';
import { MODEL_DESCTRIPTION_SYMBOL } from './decorators';
import { IModelDescriptor, RelationType, InsertBehaviour, DatetimeValueConverter, IUpdateResult, IOrderByBuilder, ISelectQueryBuilder, IWhereBuilder } from './interfaces';
import { WhereFunction } from './types';
import { RawQuery, UpdateQueryBuilder, TruncateTableQueryBuilder, QueryBuilder, SelectQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder } from './builders';
import { Op } from './enums';
import { DI, isConstructor, Class, IContainer } from '@spinajs/di';
import { Orm } from './orm';
import { ModelHydrator } from './hydrators';
import * as _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { OrmException } from './exceptions';
import { ModelDehydrator } from './dehydrators';
import { Wrap } from './statements';
import { DateTime } from 'luxon';
import { OrmDriver } from './driver';

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

export interface IModelBase {
  ModelDescriptor: IModelDescriptor;
  Container: IContainer;
  PrimaryKeyName: string;
  PrimaryKeyValue: any;
  getFlattenRelationModels(): IModelBase[];

  /**
   * Fills model with data. It only fills properties that exists in database
   *
   * @param data - data to fill
   */
  hydrate(data: Partial<this>): void;

  /**
   *
   * Attachess model to proper relation an sets foreign key
   *
   * @param data - model to attach
   */
  attach(data: ModelBase): void;

  /**
   * Extracts all data from model. It takes only properties that exists in DB
   */
  dehydrate(omit?: string[]): Partial<this>;
  /**
   * deletes enitt from db. If model have SoftDelete decorator, model is marked as deleted
   */
  destroy(): Promise<void>;
  /**
   * If model can be in achived state - sets archived at date and saves it to db
   */
  archive(): Promise<void>;

  update(): Promise<void>;

  /**
   * Save all changes to db. It creates new entry id db or updates existing one if
   * primary key exists
   */
  insert(insertBehaviour: InsertBehaviour): Promise<IUpdateResult>;

  /**
   * Gets model data from database and returns as fresh instance.
   *
   * If primary key is not fetched, tries to load by columns with unique constraint.
   * If there is no unique columns or primary key, throws error
   */
  fresh(): Promise<this>;

  /**
   * Refresh model from database.
   *
   * If no primary key is set, tries to fetch data base on columns
   * with unique constraints. If none exists, throws exception
   */
  refresh(): Promise<void>;

  toJSON(): any;

  driver(): OrmDriver;
}

export class ModelBase implements IModelBase {
  private _container: IContainer;

  /**
   * List of hidden properties from JSON / dehydratoins
   * eg. password field of user
   */
  protected _hidden: string[] = [];

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
  public static insert<T extends typeof ModelBase>(this: T, _data: InstanceType<T> | Partial<InstanceType<T>> | Array<InstanceType<T>> | Array<Partial<InstanceType<T>>>, _insertBehaviour: InsertBehaviour = InsertBehaviour.None): InsertQueryBuilder {
    throw new Error('Not implemented');
  }

  /**
   * Search entities in db
   *
   * @param column - column to search or function
   * @param operator - boolean operator
   * @param value - value to compare
   */
  public static where<T extends typeof ModelBase>(this: T, val: boolean): SelectQueryBuilder<Array<InstanceType<T>>>;
  public static where<T extends typeof ModelBase>(this: T, val: Partial<InstanceType<T>>): SelectQueryBuilder<Array<InstanceType<T>>>;
  public static where<T extends typeof ModelBase>(this: T, func: WhereFunction<InstanceType<T>>): SelectQueryBuilder<Array<InstanceType<T>>>;
  public static where<T extends typeof ModelBase>(this: T, column: string, operator: Op, value: any): SelectQueryBuilder<Array<InstanceType<T>>>;
  public static where<T extends typeof ModelBase>(this: T, column: string, value: any): SelectQueryBuilder<Array<InstanceType<T>>>;
  public static where<T extends typeof ModelBase>(this: T, statement: Wrap): SelectQueryBuilder<Array<InstanceType<T>>>;
  public static where<T extends typeof ModelBase>(this: T, column: string | boolean | WhereFunction<InstanceType<T>> | RawQuery | Partial<InstanceType<T>> | Wrap, operator?: Op | any, value?: any): SelectQueryBuilder<Array<InstanceType<T>>>;
  public static where<T extends typeof ModelBase>(this: T, _column: string | boolean | WhereFunction<InstanceType<T>> | RawQuery | Partial<InstanceType<T>> | Wrap, _operator?: Op | any, _value?: any): SelectQueryBuilder<Array<InstanceType<T>>> {
    throw new Error('Not implemented');
  }

  /**
   * Updates single or multiple records at once with provided value based on condition
   *
   * @param _data - data to set
   */
  public static update<T extends typeof ModelBase>(this: T, _data: Partial<InstanceType<T>>): UpdateQueryBuilder<InstanceType<T>> {
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
  public static first<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<number>;
  public static first<T extends typeof ModelBase>(this: T): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Tries to get first result from db
   *
   * Orders by Primary key, if pk not exists then by unique constraints and lastly by CreateAt if no unique columns exists.
   */
  public static last<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>>;
  public static last<T extends typeof ModelBase>(this: T): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Tries to get newest result from db. It throws if model dont have CreatedAt decorated property
   */
  public static newest<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>>;
  public static newest<T extends typeof ModelBase>(this: T): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Tries to get oldest result from db. It throws if model dont have CreatedAt decorated property
   */
  public static oldest<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>>;
  public static oldest<T extends typeof ModelBase>(this: T): Promise<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  /**
   * Returns total count of entries in db for this model
   */
  public static count<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>>;
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
   * Creates raw query on this model. used for quering db for partial data or to perform some kind of operations
   * that dont need full ORM model to involve
   */
  public static query<T>(this: T): SelectQueryBuilder<T> {
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

  public static destroy<T extends typeof ModelBase>(_pk?: any | any[]): DeleteQueryBuilder<InstanceType<T>> {
    throw new Error('Not implemented');
  }

  constructor(data?: unknown) {
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
        (data as any)[v.ForeignKey] = this.PrimaryKeyValue;

        switch (v.Type) {
          case RelationType.One:
            ((this as any)[v.Name] as SingleRelation<ModelBase>).attach(data);
            break;
          case RelationType.Many:
          case RelationType.ManyToMany:
            ((this as any)[v.Name] as Relation<ModelBase>).push(data);
            break;
        }
      }
    }
  }

  /**
   * Extracts all data from model. It takes only properties that exists in DB
   */
  public dehydrate(omit?: string[]): Partial<this> {
    return this.Container.resolve(ModelDehydrator).dehydrate(this, [...(omit ?? []), ...this._hidden]);
  }

  public toSql(): Partial<this> {
    const obj = {};
    const relArr = [...this.ModelDescriptor.Relations.values()];

    this.ModelDescriptor.Columns?.forEach((c) => {
      const val = (this as any)[c.Name];
      if (!c.PrimaryKey && !c.Nullable && (val === null || val === undefined || val === '')) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }
      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val) : val;
    });

    for (const val of relArr) {
      if (val.Type === RelationType.One) {
        if ((this as any)[val.Name].Value) {
          (obj as any)[val.ForeignKey] = (this as any)[val.Name].Value.PrimaryKeyValue;
        }
      }
    }

    return obj;
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
    const { query } = this.createUpdateQuery();

    if (this.ModelDescriptor.Archived) {
      (this as any)[this.ModelDescriptor.Archived.ArchivedAt] = DateTime.now();
    } else {
      throw new OrmException('archived at column not exists in model');
    }

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
      if (rel.Type === RelationType.Many) {
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

function _prepareOrderBy(description: IModelDescriptor, query: IOrderByBuilder, order?: SordOrder) {
  if (description.PrimaryKey) {
    query.order(description.PrimaryKey, order ?? SordOrder.DESC);
  } else {
    const unique = description.Columns.filter((c) => c.Unique);
    if (unique.length !== 0) {
      unique.forEach((c) => query.order(c.Name, order ?? SordOrder.DESC));
    } else if (description.Timestamps?.CreatedAt) {
      query.order(description.Timestamps.CreatedAt, order ?? SordOrder.DESC);
    } else if (description.Timestamps?.UpdatedAt) {
      query.order(description.Timestamps.UpdatedAt, order ?? SordOrder.DESC);
    }
  }
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
  const qr = cnt.resolve<T>(query, [driver, injectModel ? model : null]);

  qr.middleware(new DiscriminationMapMiddleware(dsc));
  qr.setTable(dsc.TableName);

  if (driver.Options.Database) {
    qr.database(driver.Options.Database);
  }

  return {
    query: qr,
    description: dsc,
    model,
  };
}

export const MODEL_STATIC_MIXINS = {
  truncate(): TruncateTableQueryBuilder {
    const { query } = createQuery(this, TruncateTableQueryBuilder, false);
    return query;
  },

  driver(): OrmDriver {
    const dsc = _descriptor(this);
    const orm = DI.get<Orm>(Orm);
    const driver = orm.Connections.get(dsc.Connection);

    if (!driver) {
      throw new Error(`model ${this.name} have invalid connection ${dsc.Connection}, please check your db config file or model connection name`);
    }

    return driver;
  },

  query(): SelectQueryBuilder {
    const { query } = createQuery(this, SelectQueryBuilder, false);
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
    const { query, description } = createQuery(this, InsertQueryBuilder);

    if (Array.isArray(data)) {
      if (insertBehaviour !== InsertBehaviour.None) {
        throw new OrmException(`insert behaviour is not supported with arrays`);
      }

      query.values(
        (data as Array<InstanceType<T>>).map((d) => {
          if (d instanceof ModelBase) {
            return d.toSql();
          }
          return d;
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
        query.values(data);
      }
    }

    const iMidleware = {
      afterQuery: (result: IUpdateResult) => {
        if (Array.isArray(data)) {
          (data as Array<InstanceType<T>>).forEach((v, idx) => {
            if (v instanceof ModelBase) {
              v.PrimaryKeyValue = v.PrimaryKeyValue ?? result.LastInsertId - data.length + idx;
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

    if (!pks) {
      const { query } = createQuery(this, DeleteQueryBuilder);
      return query;
    } else {
      if (description.SoftDelete?.DeletedAt) {
        const { query } = createQuery(this, UpdateQueryBuilder);
        const orm = DI.get<Orm>(Orm);
        const driver = orm.Connections.get(description.Connection);
        const converter = driver.Container.resolve(DatetimeValueConverter);

        query.whereIn(description.PrimaryKey, data).update({
          [description.SoftDelete.DeletedAt]: converter.toDB(DateTime.now()),
        });

        return query;
      } else {
        const { query } = createQuery(this, DeleteQueryBuilder);
        query.whereIn(description.PrimaryKey, data);

        return query;
      }
    }
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

  async first<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);
    _prepareOrderBy(description, query, SordOrder.ASC);

    if (callback) {
      callback(query);
    }

    return (await query.first()) as unknown as Promise<InstanceType<T>>;
  },

  async last<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);
    _prepareOrderBy(description, query, SordOrder.DESC);

    if (callback) {
      callback(query);
    }

    return (await query.first()) as unknown as Promise<InstanceType<T>>;
  },

  async newest<T extends typeof ModelBase>(this: T, callback?: (builder: IWhereBuilder<T>) => void): Promise<InstanceType<T>> {
    const { query, description } = createQuery(this as any, SelectQueryBuilder);

    if (description.Timestamps?.CreatedAt) {
      query.order(description.Timestamps.CreatedAt, SordOrder.DESC);
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
      query.order(description.Timestamps.CreatedAt, SordOrder.ASC);
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
