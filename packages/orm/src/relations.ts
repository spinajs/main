/* eslint-disable prettier/prettier */
import { InvalidOperation } from '@spinajs/exceptions';
import { IRelationDescriptor, IModelDescriptor, RelationType, ForwardRefFunction, ISelectQueryBuilder } from './interfaces.js';
import { NewInstance, DI, Constructor, Inject, Container } from '@spinajs/di';

import { BelongsToPopulateDataMiddleware, BelongsToRelationRecursiveMiddleware, BelongsToRelationResultTransformMiddleware, DiscriminationMapMiddleware, HasManyRelationMiddleware, HasManyToManyRelationMiddleware, QueryRelationMiddleware } from './middlewares.js';
import { extractModelDescriptor, ModelBase } from './model.js';
import { Orm } from './orm.js';
import { OrmDriver } from './driver.js';
import _ from 'lodash';

export interface IOrmRelation {
  /**
   * Executes relation, should be called only once.
   *
   * @param callback - optional callback to perform actions on relations eg. populate more, filter relational data etc.
   */
  execute(callback?: (this: ISelectQueryBuilder, relation: OrmRelation) => void): void;

  compile(): void;

  /**
   * Execute actions on relation query, does not initialize relation. Use it only AFTER execute was called.
   *
   * @param callback - execute callback to perform actions on relations eg. populate more, filter relational data etc.
   */
  executeOnQuery(callback: (this: ISelectQueryBuilder, relation: OrmRelation) => void): void;
 
  /**
   * Relation name
   */
  Name: string;

  Descriptor: IRelationDescriptor;
}

function _paramCheck<T>(callback: () => T, err: string) {
  const val = callback();
  if (!callback()) {
    throw new Error(err);
  }

  return val;
}

@Inject(Container)
export abstract class OrmRelation implements IOrmRelation {
  protected _targetModel: Constructor<ModelBase> | ForwardRefFunction;
  protected _targetModelDescriptor: IModelDescriptor;
  protected _relationQuery: ISelectQueryBuilder;
  protected _separator: string;
  protected _driver: OrmDriver;
  protected _compiled: boolean;

  public get Name() {
    return this._description.Name;
  }

  public get Descriptor() {
    return this._description;
  }

  get Alias(): string {
    return this.parentRelation ? `${this.parentRelation.Alias}.${this._separator}${this._description.Name}${this._separator}` : `${this._separator}${this._description.Name}${this._separator}`;
  }

  constructor(protected _container: Container, protected _query: ISelectQueryBuilder, protected _description: IRelationDescriptor, public parentRelation?: OrmRelation) {
    this._targetModel = this._description.TargetModel;
    this._targetModelDescriptor = _paramCheck(() => extractModelDescriptor(this._targetModel), `Model ${this._targetModel?.name} does not have model descriptor set`);
    this._driver = _paramCheck(() => DI.resolve<OrmDriver>('OrmConnection', [this._targetModelDescriptor.Connection]), `Connection ${this._targetModelDescriptor.Connection} is not set in configuration file`);
    this._relationQuery = this._container.resolve('SelectQueryBuilder', [this._driver, this._targetModel, this]);
    this._separator = this._driver.Options.AliasSeparator;

    if (this._driver.Options.Database) {
      this._relationQuery.database(this._driver.Options.Database);
    }
  }

  public abstract compile(): void;

  public execute(callback?: (this: ISelectQueryBuilder, relation: OrmRelation) => void) {
    if (callback) {
      callback.call(this._relationQuery, this);
    }
  }

  public executeOnQuery(callback: (this: ISelectQueryBuilder<any>, relation: OrmRelation) => void): void {
    if (callback) {
      callback.call(this._relationQuery, this);
    }
  }
}

@NewInstance()
@Inject(Container)
export class BelongsToRelation extends OrmRelation {
  constructor(_container: Container, _query: ISelectQueryBuilder<any>, _description: IRelationDescriptor, _parentRelation?: OrmRelation) {
    super(_container, _query, _description, _parentRelation);

    this._relationQuery.from(this._targetModelDescriptor.TableName, this.Alias);
    this._targetModelDescriptor.Columns.forEach((c) => {
      this._relationQuery.select(c.Name, `${this.Alias}.${c.Name}`);
    });
  }

  public compile() {
    if (this._compiled) {
      return;
    }

    if (!this.parentRelation && !this._query.TableAlias) {
      this._query.setAlias(`${this._separator}${this._description.SourceModel.name}${this._separator}`);
    }

    this._query.leftJoin(this._targetModelDescriptor.TableName, this.Alias, this._description.PrimaryKey, this._description.ForeignKey, this._targetModelDescriptor.Driver.Options.Database);

    this._relationQuery.Relations.forEach((r) => r.compile());

    // todo: fix this cast
    (this._query as any).mergeBuilder(this._relationQuery);

    this._query.middleware(new BelongsToPopulateDataMiddleware(this._description, this));
    if (!this.parentRelation || !(this.parentRelation instanceof BelongsToRelation)) {
      // if we are on top of the belongsTo relation stack
      // add transform middleware
      // we do this becouse belongsTo modifies query (not creating new like oneToMany and manyToMany)
      // and we only need to run transform once
      this._query.middleware(new BelongsToRelationResultTransformMiddleware());
    }

    this._compiled = true;
  }
}

@NewInstance()
@Inject(Container)
export class BelongsToRecursiveRelation extends OrmRelation {
  constructor(_container: Container, _query: ISelectQueryBuilder<any>, _description: IRelationDescriptor, _parentRelation?: OrmRelation) {
    super(_container, _query, _description, _parentRelation);

    this._relationQuery.withRecursive(this._description.ForeignKey, this._description.PrimaryKey).from(this._targetModelDescriptor.TableName, this.Alias);
    this._targetModelDescriptor.Columns.forEach((c) => {
      this._relationQuery.select(c.Name, `${this.Alias}.${c.Name}`);
    });
  }
 
  public compile() {
    if (this._compiled) {
      return;
    }

    this._relationQuery.Relations.forEach((r) => r.compile());
    // todo: fix this cast
    // (this._query as any).mergeBuilder(this._relationQuery);
    this._query.middleware(new BelongsToRelationRecursiveMiddleware(this._relationQuery, this._description, this._targetModelDescriptor));

    this._compiled = true;
  }
}

@NewInstance()
@Inject(Container)
export class QueryRelation extends OrmRelation {

 

  public compile(): void {
    this._query.middleware(new QueryRelationMiddleware(this._description.Callback, this._description.Mapper, this._description));
  }
}

@NewInstance()
@Inject(Container)
export class OneToManyRelation extends OrmRelation {
  constructor(_container: Container, _query: ISelectQueryBuilder<any>, _description: IRelationDescriptor, _parentRelation?: OrmRelation) {
    super(_container, _query, _description, _parentRelation);

    this._relationQuery.from(this._targetModelDescriptor.TableName, this.Alias);
    this._relationQuery.columns(
      this._targetModelDescriptor.Columns.map((c) => {
        return c.Name;
      }),
    );
  }

 
  public compile(): void {
    if (this._compiled) {
      return;
    }

    if (!this.parentRelation && !this._query.TableAlias) {
      this._query.setAlias(`${this._separator}${this._description.SourceModel.name}${this._separator}`);
    }

    this._relationQuery.Relations.forEach((r) => r.compile());

    this._query.middleware(new DiscriminationMapMiddleware(this._targetModelDescriptor));
    this._query.middleware(new HasManyRelationMiddleware(this._relationQuery, this._description, null));

    this._compiled = true;
  }
}

@NewInstance()
@Inject(Container, Orm)
export class ManyToManyRelation extends OrmRelation {
  protected _joinModel: Constructor<ModelBase>;
  protected _joinModelDescriptor: IModelDescriptor;
  protected _joinQuery: ISelectQueryBuilder;

  public get TableJoinQuery() {
    return this._joinQuery;
  }

  public get RelationQuery() {
    return this._relationQuery;
  }

  constructor(_container: Container, protected _orm: Orm, _query: ISelectQueryBuilder<any>, _description: IRelationDescriptor, _parentRelation?: OrmRelation) {
    super(_container, _query, _description, _parentRelation);

    this._joinModel = this._orm.Models.find((m) => m.name === this._description.JunctionModel?.name)?.type ?? undefined;

    if (this._joinModel === undefined) {
      throw new InvalidOperation(`model ${this._description.JunctionModel} not exists in orm module`);
    }

    this._joinModelDescriptor = extractModelDescriptor(this._joinModel);

    const orm = DI.get<Orm>(Orm);
    const driver = orm.Connections.get(this._joinModelDescriptor.Connection);

    const cnt = driver.Container;
    this._joinQuery = cnt.resolve<ISelectQueryBuilder>('SelectQueryBuilder', [driver, this._targetModel, this]);

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
 

  public compile(): void {
    if (this._compiled) {
      return;
    }

    if (this._description.JoinMode === 'RightJoin') {
      this._joinQuery.rightJoin(this._targetModelDescriptor.TableName, this.Alias, this._description.JunctionModelTargetModelFKey_Name, this._description.ForeignKey, this._targetModelDescriptor.Driver.Options.Database);
    } else {
      this._joinQuery.leftJoin(this._targetModelDescriptor.TableName, this.Alias, this._description.JunctionModelTargetModelFKey_Name, this._description.ForeignKey, this._targetModelDescriptor.Driver.Options.Database);
    }

    this._relationQuery.Relations.forEach((r) => r.compile());

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

    // todo fix this cast
    (this._joinQuery as any).mergeBuilder(this._relationQuery);
    (this._joinQuery as any).mergeRelations(this._relationQuery);

    this._query.middleware(new HasManyToManyRelationMiddleware(this._joinQuery, joinRelationDescriptor, this._targetModelDescriptor));

    this._compiled = true;
  }
}
