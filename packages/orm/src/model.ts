import { IOrderByBuilder } from '@spinajs/orm';

/* eslint-disable prettier/prettier */
import { DiscriminationMapMiddleware, OneToManyRelationList, ManyToManyRelationList, Relation } from './relations';
import { MODEL_DESCTRIPTION_SYMBOL } from './decorators';
import { IModelDescrtiptor, RelationType, InsertBehaviour, DatetimeValueConverter, IUpdateResult } from './interfaces';
import { WhereFunction } from './types';
import { RawQuery, UpdateQueryBuilder, QueryBuilder, SelectQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder } from './builders';
import { Op, SqlOperator } from './enums';
import { DI, isConstructor, Class, IContainer } from '@spinajs/di';
import { Orm } from './orm';
import { ModelHydrator } from './hydrators';
import * as _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { OrmException } from './exceptions';
import { ModelDehydrator } from './dehydrators';

export function extractModelDescriptor(targetOrForward: any): IModelDescrtiptor {
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

export class ModelBase {
  private _descriptor: IModelDescrtiptor;
  private _container: IContainer;

  /**
   * Gets descriptor for this model. It contains information about relations, orm driver, connection properties,
   * db table attached, column information and others.
   */
  public get ModelDescriptor() {
    if (!this._descriptor) {
      this._descriptor = extractModelDescriptor(this.constructor);
    }

    return this._descriptor;
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

  /**
   * Get all data from db
   */
  public static all<T extends typeof ModelBase>(this: T, _page?: number, _perPage?: number): SelectQueryBuilder<Array<InstanceType<T>>> {
    throw Error('Not implemented');
  }

  /**
   * Inserts data to DB.
   *
   * @param _data - data to insert
   */
  public static insert<T extends typeof ModelBase>(this: T, _data: InstanceType<T> | Partial<InstanceType<T>> | Array<InstanceType<T>> | Array<Partial<InstanceType<T>>>): InsertQueryBuilder {
    throw Error('Not implemented');
  }

  /**
   * Search entities in db
   *
   * @param column - column to search or function
   * @param operator - boolean operator
   * @param value - value to compare
   */
  public static where<T extends typeof ModelBase>(this: T, _column: string | boolean | WhereFunction | RawQuery | object, _operator?: SqlOperator | any, _value?: any): SelectQueryBuilder<Array<InstanceType<T>>> {
    throw Error('Not implemented');
  }

  /**
   * Updates single or multiple records at once with provided value based on condition
   *
   * @param _data - data to set
   */
  public static update<T extends typeof ModelBase>(this: T, _data: Partial<InstanceType<T>>): UpdateQueryBuilder {
    throw Error('Not implemented');
  }

  /**
   * Tries to find all models with given primary keys
   */
  public static find<T extends typeof ModelBase>(this: T, _pks: any[]): Promise<Array<InstanceType<T>>> {
    throw Error('Not implemented');
  }

  /**
   * Tries to find all models in db. If not all exists, throws exception
   */
  public static findOrFail<T extends typeof ModelBase>(this: T, _pks: any[]): Promise<Array<InstanceType<T>>> {
    throw Error('Not implemented');
  }

  /**
   * gets model by specified pk, if not exists, returns null
   *
   */
  public static get<T extends typeof ModelBase>(this: T, _pk: any): Promise<InstanceType<T>> {
    throw Error('Not implemented');
  }

  /**
   * Finds model by specified pk. If model not exists in db throws exception
   *
   */
  public static getOrFail<T extends typeof ModelBase>(this: T, _pk: any): Promise<InstanceType<T>> {
    throw Error('Not implemented');
  }

  /**
   *
   * Checks if model with pk key or unique fields exists and if not creates one AND NOT save in db
   * NOTE: it checks for unique fields constraint
   */
  public static getOrNew<T extends typeof ModelBase>(this: T, _pk?: any, _data?: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    throw Error('Not implemented');
  }

  /**
   * Creates raw query on this model. used for quering db for partial data or to perform some kind of operations
   * that dont need full ORM model to involve
   */
  public static query<T>(this: T): SelectQueryBuilder<T> {
    throw Error('Not implemented');
  }

  /**
   *
   * Checks if model with pk key / unique fields exists and if not creates one and saves to db
   * NOTE: it checks for unique fields too.
   *
   * @param data - model width data to check
   */
  public static getOrCreate<T extends typeof ModelBase>(this: T, _pk: any, _data?: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    throw Error('Not implemented');
  }

  /**
   * Creates new model & saves is to db
   *
   * @param  data - initial model data
   */
  public static create<T extends typeof ModelBase>(this: T, _data: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    throw Error('Not implemented');
  }

  /**
   * Deletes model from db
   *
   * @param pk - primary key
   */

  public static destroy(_pk?: any | any[]): Promise<void> {
    throw Error('Not implemented');
  }

  constructor(data?: any) {
    this.setDefaults();

    if (data) {
      Object.assign(this, data);
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
            (this as any)[v.Name] = data;
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
  public dehydrate(): Partial<this> {
    return this.Container.resolve(ModelDehydrator).dehydrate(this);
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

  public async update() {
    const { query } = _createQuery(this.constructor, UpdateQueryBuilder);

    if (this.ModelDescriptor.Timestamps.UpdatedAt) {
      (this as any)[this.ModelDescriptor.Timestamps.UpdatedAt] = new Date();
    }

    await query.update(this.dehydrate()).where(this.PrimaryKeyName, this.PrimaryKeyValue);
  }

  /**
   * Save all changes to db. It creates new entry id db or updates existing one if
   * primary key exists
   */
  public async insert(insertBehaviour: InsertBehaviour = InsertBehaviour.None) {
    const { query, description } = _createQuery(this.constructor, InsertQueryBuilder);

    switch (insertBehaviour) {
      case InsertBehaviour.OnDuplicateIgnore:
        query.ignore();
        break;
      case InsertBehaviour.OnDuplicateUpdate:
        query.onDuplicate().update(description.Columns.filter((c) => !c.PrimaryKey).map((c) => c.Name));
        break;
    }

    const { LastInsertId, RowsAffected } = (await query.values(this.dehydrate())) as unknown as IUpdateResult;

    if (RowsAffected !== 0) {
      this.PrimaryKeyValue = this.PrimaryKeyValue ?? LastInsertId;
    }
  }

  /**
   * Gets model data from database and returns as fresh instance.
   *
   * If primary key is not fetched, tries to load by columns with unique constraint.
   * If there is no unique columns or primary key, throws error
   */
  public async fresh(): Promise<this> {
    const { query, description } = _createQuery(this.constructor, SelectQueryBuilder);
    query.select('*');

    if (this.PrimaryKeyValue) {
      query.where(this.PrimaryKeyName, this.PrimaryKeyValue);
    } else {
      const unique = this.ModelDescriptor.Columns.filter((x) => x.Unique);
      if (unique.length !== 0) {
        for (const c of unique) {
          query.where(c.Name, '=', (this as any)[c.Name]);
        }
      } else {
        throw new OrmException('Model dont have primary key set or columns with unique constraint, cannot fetch model from database');
      }
    }

    _prepareOrderBy(description, query);

    return await query.firstOrFail();
  }

  /**
   * Refresh model from database.
   *
   * If no primary key is set, tries to fetch data base on columns
   * with unique constraints. If none exists, throws exception
   */
  public async refresh(): Promise<void> {
    let model: this = null;
    const { query, description } = _createQuery(this.constructor, SelectQueryBuilder);
    query.select('*');

    if (this.PrimaryKeyValue) {
      query.where(this.PrimaryKeyName, this.PrimaryKeyValue);
    } else {
      const unique = this.ModelDescriptor.Columns.filter((x) => x.Unique);
      if (unique.length !== 0) {
        for (const c of unique) {
          query.where(c.Name, '=', (this as any)[c.Name]);
        }
      } else {
        throw new OrmException('Model dont have primary key set or columns with unique constraint, cannot fetch model from database');
      }
    }

    _prepareOrderBy(description, query);

    model = await query.firstOrFail();

    for (const c of this.ModelDescriptor.Columns) {
      (this as any)[c.Name] = (model as any)[c.Name];
    }
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
      (this as any)[this.ModelDescriptor.Timestamps.CreatedAt] = new Date();
    }

    for (const [, rel] of this.ModelDescriptor.Relations) {
      if (rel.Type === RelationType.Many) {
        (this as any)[rel.Name] = new OneToManyRelationList(this, rel.TargetModel, rel, []);
      } else if (rel.Type === RelationType.ManyToMany) {
        (this as any)[rel.Name] = new ManyToManyRelationList(this, rel.TargetModel, rel, []);
      } else {
        (this as any)[rel.Name] = null;
      }
    }
  }
}

function _descriptor(model: Class<any>) {
  return (model as any)[MODEL_DESCTRIPTION_SYMBOL] as IModelDescrtiptor;
}

function _prepareOrderBy(description: IModelDescrtiptor, query: IOrderByBuilder) {
  if (description.PrimaryKey) {
    query.orderByDescending(description.PrimaryKey);
  } else {
    const unique = description.Columns.filter((c) => c.Unique);
    if (unique.length !== 0) {
      unique.forEach((c) => query.orderByDescending(c.Name));
    } else if (description.Timestamps?.CreatedAt) {
      query.orderByDescending(description.Timestamps.CreatedAt);
    } else if (description.Timestamps?.UpdatedAt) {
      query.orderByDescending(description.Timestamps.UpdatedAt);
    }
  }
}

function _createQuery<T extends QueryBuilder>(model: Class<any>, query: Class<T>, injectModel = true) {
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
  query(): SelectQueryBuilder {
    const { query } = _createQuery(this, SelectQueryBuilder, false);
    return query;
  },

  where(column: string | boolean | WhereFunction | RawQuery | {}, operator?: Op | any, value?: any): SelectQueryBuilder {
    const { query } = _createQuery(this, SelectQueryBuilder);
    query.select('*');

    return query.where(column, operator, value);
  },

  update<T extends typeof ModelBase>(data: Partial<InstanceType<T>>): UpdateQueryBuilder {
    const { query } = _createQuery(this, UpdateQueryBuilder);
    return query.update(data);
  },

  all(page: number, perPage: number): SelectQueryBuilder {
    const { query } = _createQuery(this, SelectQueryBuilder);

    query.select('*');
    if (page >= 0 && perPage > 0) {
      query.take(perPage).skip(page * perPage);
    }

    return query;
  },

  /**
   * Try to insert new value
   */
  insert<T extends typeof ModelBase>(this: T, data: InstanceType<T> | Partial<InstanceType<T>> | Array<InstanceType<T>> | Array<Partial<InstanceType<T>>>) {
    const { query } = _createQuery(this, InsertQueryBuilder);

    if (Array.isArray(data)) {
      query.values(
        (data as Array<InstanceType<T>>).map((d) => {
          if (d instanceof ModelBase) {
            return d.dehydrate();
          }
          return d;
        }),
      );
    } else {
      if (data instanceof ModelBase) {
        query.values(data.dehydrate());
      } else {
        query.values(data);
      }
    }

    return query;
  },

  async find<T extends typeof ModelBase>(this: T, pks: any[]): Promise<Array<InstanceType<T>>> {
    const { query, description } = _createQuery(this as any, SelectQueryBuilder);
    const pkey = description.PrimaryKey;
    query.select('*');
    query.whereIn(pkey, pks);
    return await query;
  },

  async findOrFail<T extends typeof ModelBase>(this: T, pks: any[]): Promise<Array<InstanceType<T>>> {
    const { query, description } = _createQuery(this as any, SelectQueryBuilder);
    const pkey = description.PrimaryKey;

    const middleware = {
      afterData(data: any[]) {
        if (data.length !== pks.length) {
          throw new Error(`could not find all of pkeys in model ${this.model.name}`);
        }

        return data;
      },

      modelCreation(_: any): ModelBase {
        return null;
      },

      // tslint:disable-next-line: no-empty
      async afterHydration(_data: ModelBase[]) {},
    };

    query.select('*');
    query.whereIn(pkey, pks);
    query.middleware(middleware);

    return await query;
  },

  async get<T extends typeof ModelBase>(this: T, pk: any): Promise<InstanceType<T>> {
    const { query, description } = _createQuery(this as any, SelectQueryBuilder);
    const pkey = description.PrimaryKey;

    query.select('*');
    query.where(pkey, pk);

    _prepareOrderBy(description, query);

    return await query.first();
  },

  async getOrFail<T extends typeof ModelBase>(this: T, pk: any): Promise<InstanceType<T>> {
    const { query, description } = _createQuery(this as any, SelectQueryBuilder);
    const pkey = description.PrimaryKey;

    query.select('*');
    query.where(pkey, pk);

    _prepareOrderBy(description, query);

    return await query.firstOrFail();
  },

  async destroy(pks: any | any[]): Promise<void> {
    const description = _descriptor(this);

    const data = Array.isArray(pks) ? pks : [pks];

    if (description.SoftDelete?.DeletedAt) {
      const { query } = _createQuery(this, UpdateQueryBuilder);
      const orm = DI.get<Orm>(Orm);
      const driver = orm.Connections.get(description.Connection);
      const converter = driver.Container.resolve(DatetimeValueConverter);

      await query.whereIn(description.PrimaryKey, data).update({
        [description.SoftDelete.DeletedAt]: converter.toDB(new Date()),
      });
    } else {
      const { query } = _createQuery(this, DeleteQueryBuilder);
      await query.whereIn(description.PrimaryKey, data);
    }
  },

  async create<T extends typeof ModelBase>(this: T, data: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const entity = new (Function.prototype.bind.apply(this))(data);
    await (entity as ModelBase).insert();
    return entity;
  },

  async getOrCreate<T extends typeof ModelBase>(this: T, pk: any, data: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const { query, description } = _createQuery(this as any, SelectQueryBuilder);

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
      await (entity as ModelBase).insert();
      return entity;
    }

    return entity;
  },

  async getOrNew<T extends typeof ModelBase>(this: T, pk: any, data?: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const { query, description } = _createQuery(this as any, SelectQueryBuilder);

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
};
