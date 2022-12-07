/* eslint-disable prettier/prettier */
import { InvalidOperation, InvalidArgument } from '@spinajs/exceptions';
import { IRelationDescriptor, IModelDescriptor, RelationType, InsertBehaviour, ForwardRefFunction, IBuilderMiddleware } from './interfaces';
import { NewInstance, DI, Constructor } from '@spinajs/di';
import { SelectQueryBuilder, DeleteQueryBuilder } from './builders';
import { createQuery, extractModelDescriptor, IModelBase, ModelBase } from './model';
import { Orm } from './orm';
import * as _ from 'lodash';

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
    const pks = data.map((d) => {
      if (this._path) {
        return _.get(d as any, this._path)[this._description.PrimaryKey];
      } else {
        return (d as any)[this._description.PrimaryKey];
      }
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
        data.forEach((d) => {
          const relData = relationData.filter((rd) => {
            if (self._path) {
              return _.get(d as any, self._path)[self._description.PrimaryKey] === (rd as any)[self._description.ForeignKey];
            } else {
              return (rd as any)[self._description.ForeignKey] === (d as any)[self._description.PrimaryKey];
            }
          });

          if (self._path) {
            _.get(d as any, self._path)[self._description.Name] = new OneToManyRelationList(d, self._description.TargetModel, self._description, relData);
          } else {
            (d as any)[self._description.Name] = new OneToManyRelationList(d, self._description.TargetModel, self._description, relData);
          }
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
    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data;
      },
      modelCreation(_: any): ModelBase {
        return null;
      },
      async afterHydration(relationData: ModelBase[]) {
        relationData.forEach((d) => ((d as any).__relationKey__ = self._description.Name));

        const roots = relationData.filter((rd) => (rd as any)[self._description.ForeignKey] === 0 || (rd as any)[self._description.ForeignKey] === null);
        const leafs = roots.map((r) => {
          return fillRecursive(r);

          function fillRecursive(parent: any): any {
            const child = relationData.find((rd) => (rd as any)[self._description.ForeignKey] === parent[self._description.PrimaryKey]);
            if (!child) {
              return parent;
            }

            (child as any)[self._description.Name] = new SingleRelation(child, self._description.TargetModel, self._description, parent);
            return fillRecursive(child);
          }
        });

        data.forEach((d) => {
          const val = leafs.find((l) => l[self._description.PrimaryKey] === (d as any)[self._description.PrimaryKey])[self._description.Name];
          const rel = val;
          (d as any)[self._description.Name] = rel;
        });
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
      this._relationQuery.middleware(new BelongsToRelationResultTransformMiddleware(this._description));
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

class BelongsToRelationResultTransformMiddleware implements IBuilderMiddleware {
  constructor(protected _description: IRelationDescriptor) {}

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

class BelongsToRelationResultTransformOneToManyMiddleware extends BelongsToRelationResultTransformMiddleware {
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
  protected _targetModel: Constructor<ModelBase>;
  protected _targetModelDescriptor: IModelDescriptor;
  protected _relationQuery: SelectQueryBuilder;

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

    this._query.mergeStatements(this._relationQuery);

    if (!this.parentRelation) {
      // if we are on top of the belongsTo relation stack
      // add transform middleware
      // we do this becouse belongsTo modifies query (not creating new like oneToMany and manyToMany)
      // and we only need to run transform once
      this._query.middleware(new BelongsToRelationResultTransformMiddleware(this._description));
    } else if (!this.parentRelation.parentRelation && this.parentRelation instanceof OneToManyRelation) {
      // if we called populate from OneToMany relation
      // we must use different path transform ( couse onetomany is separate query)
      // otherwise we would fill invalid property on entity
      this._query.middleware(new BelongsToRelationResultTransformOneToManyMiddleware(this._description));
    }
  }
}

@NewInstance()
export class BelongsToRecursiveRelation extends OrmRelation {
  protected _targetModel: Constructor<ModelBase>;
  protected _targetModelDescriptor: IModelDescriptor;
  protected _relationQuery: SelectQueryBuilder;

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

    const path = [];
    let cur = this.parentRelation;
    while (cur && !(cur instanceof OneToManyRelation)) {
      path.push(cur._description.Name);
      cur = cur.parentRelation;
    }

    if (callback) {
      callback.call(this._relationQuery, [this]);
    }

    this._query.middleware(new DiscriminationMapMiddleware(this._targetModelDescriptor));
    this._query.middleware(new HasManyRelationMiddleware(this._relationQuery, this._description, path.join('.')));
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
      TargetModel: this._description.JunctionModel,
      SourceModel: this._description.SourceModel,
      ForeignKey: this._description.JunctionModelSourceModelFKey_Name,
      PrimaryKey: this._description.PrimaryKey,
      Recursive: false,
    };

    this._joinQuery.mergeStatements(this._relationQuery);

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


  constructor(protected owner: O, protected model: Constructor<R> | ForwardRefFunction, protected Relation: IRelationDescriptor, objects?: R[]) {
    super();

    if (objects) {
      this.push(...objects);
    }

    this.TargetModelDescriptor = extractModelDescriptor(model);
    this.Orm = DI.get(Orm);
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

  public abstract intersection(obj: R[], callback?: (a: R, b: R) => boolean): Promise<void>;
  public abstract union(obj: R[], mode?: InsertBehaviour): Promise<void>;
  public abstract diff(obj: R[], callback?: (a: R, b: R) => boolean): Promise<void>;
  public abstract set(obj: R[]): Promise<void>;

  /**
   * Populates this relation
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

export class ManyToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T,O> {
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
    const driver = this.Orm.Connections.get(this.TargetModelDescriptor.Connection);
    const jmodelDescriptor = extractModelDescriptor(this.Relation.JunctionModel);

    if (!driver) {
      throw new InvalidArgument(`connection ${this.TargetModelDescriptor.Connection} not exists`);
    }

    const query = driver.Container.resolve<DeleteQueryBuilder<T>>(DeleteQueryBuilder, [driver, this.Relation.JunctionModel])
      .from(jmodelDescriptor.TableName)
      .where(function () {
        this.whereIn(self.Relation.JunctionModelTargetModelFKey_Name, data);
        this.andWhere(self.Relation.JunctionModelSourceModelFKey_Name, self.owner.PrimaryKeyValue);
      });

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

export class OneToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T,O>  {
  public async diff(obj: T[], callback?: (a: T, b: T) => boolean): Promise<void> {
    const result = callback ? _.differenceWith(obj, [...this], callback) : _.differenceBy(obj, [...this], this.TargetModelDescriptor.PrimaryKey);
    const result2 = callback ? _.differenceWith([...this], obj, callback) : _.differenceBy([...this], obj, this.TargetModelDescriptor.PrimaryKey);
    const finalDiff = [...result, ...result2];

    const self = this;
    const driver = this.Orm.Connections.get(this.TargetModelDescriptor.Connection);
    const relData = finalDiff.filter((x) => x.PrimaryKeyValue).map((x) => x.PrimaryKeyValue);

    const query = driver.Container.resolve<DeleteQueryBuilder<T>>(DeleteQueryBuilder, [driver, this.Relation.TargetModel]).andWhere(function () {
      if (relData.length !== 0) {
        this.whereNotIn(self.Relation.PrimaryKey, relData);
      }

      this.where(self.Relation.ForeignKey, self.owner.PrimaryKeyValue);
    });

    query.setTable(this.TargetModelDescriptor.TableName);

    if (driver.Options.Database) {
      query.database(driver.Options.Database);
    }

    await query;
    this.empty();

    await this.add(finalDiff), InsertBehaviour.InsertOrUpdate;
  }

  public async set(obj: T[]): Promise<void> {
    const self = this;
    const driver = this.Orm.Connections.get(this.TargetModelDescriptor.Connection);
    const query = driver.Container.resolve<DeleteQueryBuilder<T>>(DeleteQueryBuilder, [driver, this.Relation.TargetModel]).andWhere(function () {
      const relData = obj.filter((x) => x.PrimaryKeyValue).map((x) => x.PrimaryKeyValue);

      if (relData.length !== 0) {
        this.whereNotIn(self.Relation.PrimaryKey, relData);
      }
      this.where(self.Relation.ForeignKey, self.owner.PrimaryKeyValue);
    });

    query.setTable(this.TargetModelDescriptor.TableName);

    if (driver.Options.Database) {
      query.database(driver.Options.Database);
    }

    await query;

    this.empty();

    await this.add(obj, InsertBehaviour.InsertOrUpdate);
  }

  public async intersection(obj: T[], callback?: (a: T, b: T) => boolean): Promise<void> {
    const self = this;
    const result = callback ? _.intersectionWith(obj, [...this], callback) : _.intersectionBy(obj, [...this], this.TargetModelDescriptor.PrimaryKey);
    const driver = this.Orm.Connections.get(this.TargetModelDescriptor.Connection);

    const query = driver.Container.resolve(DeleteQueryBuilder, [driver, this.Relation.TargetModel]).andWhere(function () {
      const relData = result.filter((x) => x.PrimaryKeyValue).map((x) => x.PrimaryKeyValue);
      if (relData.length !== 0) {
        this.whereNotIn(self.Relation.PrimaryKey, relData);
      }

      this.where(self.Relation.ForeignKey, self.owner.PrimaryKeyValue);
    });

    query.setTable(this.TargetModelDescriptor.TableName);

    if (driver.Options.Database) {
      query.database(driver.Options.Database);
    }

    await query;
    this.empty();

    await this.add(result, InsertBehaviour.InsertOrUpdate);
  }

  public async union(obj: T[], mode?: InsertBehaviour): Promise<void> {
    await this.add(obj, mode);
  }

  public async remove(obj: T | T[]): Promise<void> {
    const data = (Array.isArray(obj) ? obj : [obj]).map((d) => (d as ModelBase).PrimaryKeyValue);
    const driver = this.Orm.Connections.get(this.TargetModelDescriptor.Connection);

    if (!driver) {
      throw new InvalidArgument(`connection ${this.TargetModelDescriptor.Connection} not exists`);
    }

    const query = driver.Container.resolve<DeleteQueryBuilder<T>>(DeleteQueryBuilder, [driver, this.Relation.TargetModel]).whereIn(this.Relation.ForeignKey, data);

    query.setTable(this.TargetModelDescriptor.TableName);

    if (driver.Options.Database) {
      query.database(driver.Options.Database);
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

      if (_.isFunction(this.model)) {
        return new (this.model())(x);
      }

      return new this.model(x);
    }) as T[];

    data.forEach((d) => {
      (d as any)[this.Relation.ForeignKey] = this.owner.PrimaryKeyValue;
    });

    for (const m of data) {
      if (m.PrimaryKeyValue) {
        await m.update();
      } else {
        await m.insert(mode);
      }
    }

    this.push(...tInsert);
  }
}
