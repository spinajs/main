/* eslint-disable prettier/prettier */
import { DiscriminationMapMiddleware, OneToManyRelationList, ManyToManyRelationList } from './relations';
import { MODEL_DESCTRIPTION_SYMBOL } from './decorators';
import { IModelDescrtiptor, RelationType, InsertBehaviour, DatetimeValueConverter } from './interfaces';
import { WhereFunction } from './types';
import { RawQuery, UpdateQueryBuilder, QueryBuilder, SelectQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder } from './builders';
import { WhereOperators } from './enums';
import { DI, isConstructor, Class } from '@spinajs/di';
import { Orm } from './orm';
import { ModelHydrator } from './hydrators';
import * as _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { OrmException } from './exceptions';

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
  /**
   * Gets descriptor for this model. It contains information about relations, orm driver, connection properties,
   * db table attached, column information and others.
   */
  public get ModelDescriptor() {
    return extractModelDescriptor(this.constructor);
  }

  public get PrimaryKeyName() {
    return this.ModelDescriptor.PrimaryKey;
  }

  public get PrimaryKeyValue() {
    return (this as any)[this.PrimaryKeyName];
  }

  public set PrimaryKeyValue(newVal: any) {
    (this as any)[this.PrimaryKeyName] = newVal;
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
  public static insert<T extends typeof ModelBase>(this: T, _data: InstanceType<T> | Partial<InstanceType<T>> | Array<InstanceType<T>> | Array<Partial<InstanceType<T>>>): Promise<void> {
    throw Error('Not implemented');
  }

  /**
   * Search entities in db
   *
   * @param column - column to search or function
   * @param operator - boolean operator
   * @param value - value to compare
   */
  public static where<T extends typeof ModelBase>(this: T, _column: string | boolean | WhereFunction | RawQuery | object, _operator?: WhereOperators | any, _value?: any): SelectQueryBuilder<Array<InstanceType<T>>> {
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
  public static get<T extends typeof ModelBase>(this: T, _pk: any): Promise<Array<InstanceType<T>>> {
    throw Error('Not implemented');
  }

  /**
   * Finds model by specified pk. If model not exists in db throws exception
   *
   */
  public static getOrFail<T extends typeof ModelBase>(this: T, _pk: any): Promise<Array<InstanceType<T>>> {
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
    DI.resolve(Array.ofType(ModelHydrator)).forEach((h) => h.hydrate(this, data));
  }

  /**
   * Extracts all data from model. It takes only properties that exists in DB
   */
  public dehydrate(): Partial<this> {
    const obj = {};

    this.ModelDescriptor.Columns?.forEach((c) => {
      const val = (this as any)[c.Name];
      if ((!c.Nullable && (val === null|| val === undefined || val === '')) ) {
        throw new OrmException(`Field ${c.Name} cannot be null`);
      }
      (obj as any)[c.Name] = c.Converter ? c.Converter.toDB(val) : val;
    });

    for (const [, val] of this.ModelDescriptor.Relations) {
      if (val.Type === RelationType.One) {
        if ((this as any)[val.Name]) {
          (obj as any)[val.ForeignKey] = (this as any)[val.Name].PrimaryKeyValue;
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
    const self = this;

    const { query, description } = _createQuery(this.constructor, InsertQueryBuilder);

    switch (insertBehaviour) {
      case InsertBehaviour.OnDuplicateIgnore:
        query.ignore();
        break;
      case InsertBehaviour.OnDuplicateUpdate:
        query.onDuplicate().update(description.Columns.filter((c) => !c.PrimaryKey).map((c) => c.Name));
        break;
    }

    const id = await query.values(this.dehydrate());

    // ignore fired, we dont have insert ID
    if (insertBehaviour !== InsertBehaviour.None && (id as any) === 0 && !this.PrimaryKeyValue) {
      const { query, description } = _createQuery(this.constructor, SelectQueryBuilder, false);
      const idRes = await query
        .columns([this.PrimaryKeyName])
        .where(function () {
          description.Columns.filter((c) => c.Unique).forEach((c) => {
            this.where(c, (self as any)[c.Name]);
          });
        })
        .first();

      this.PrimaryKeyValue = (idRes as any)[this.PrimaryKeyName];
    } else {
      this.PrimaryKeyValue = id;
    }
  }

  /**
   * Gets model data from database and returns as fresh instance.
   */
  public async fresh(): Promise<this> {
    return (this.constructor as any).get(this.PrimaryKeyValue);
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
    qr.schema(driver.Options.Database);
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

  where(column: string | boolean | WhereFunction | RawQuery | {}, operator?: WhereOperators | any, value?: any): SelectQueryBuilder {
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

    return await query.first();
  },

  async getOrFail<T extends typeof ModelBase>(this: T, pk: any): Promise<InstanceType<T>> {
    const { query, description } = _createQuery(this as any, SelectQueryBuilder);
    const pkey = description.PrimaryKey;

    query.select('*');
    query.where(pkey, pk);

    return await query.firstOrFail();
  },

  async destroy(pks: any | any[]): Promise<void> {
    const description = _descriptor(this);
    const orm = DI.get<Orm>(Orm);
    const driver = orm.Connections.get(description.Connection);
    const converter = driver.Container.resolve(DatetimeValueConverter);
    const data = Array.isArray(pks) ? pks : [pks];

    if (description.SoftDelete?.DeletedAt) {
      const { query } = _createQuery(this, UpdateQueryBuilder);

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
    query.where(description.PrimaryKey, pk);

    // check for all unique columns ( unique constrain )
    description.Columns.filter((c) => c.Unique).forEach((c) => {
      query.andWhere(c, (data as any)[c.Name]);
    });

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
    query.where(description.PrimaryKey, pk);

    // check for all unique columns ( unique constrain )
    description.Columns.filter((c) => c.Unique).forEach((c) => {
      query.andWhere(c, (data as any)[c.Name]);
    });

    let entity = (await query.first()) as any;

    if (!entity) {
      entity = new (Function.prototype.bind.apply(this))(data);
      return entity;
    }

    return entity;
  },
};
