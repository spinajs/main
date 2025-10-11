import { JoinMethod, Op } from './enums.js';
/* eslint-disable prettier/prettier */
import { QueryBuilder, RawQuery } from './builders.js';
import { SortOrder, WhereBoolean } from './enums.js';
import { IQueryStatement, Wrap } from './statements.js';
import { ModelData, ModelDataWithRelationData, ModelDataWithRelationDataSearchable, PartialArray, PickRelations, Unbox, WhereFunction } from './types.js';
import { IOrmRelation } from './relations.js';
import { OrmDriver } from './driver.js';
import { NewInstance, Constructor, Singleton, IContainer } from '@spinajs/di';
import { ModelBase } from './model.js';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { DateTime } from 'luxon';
import { Relation } from './relation-objects.js';
import { Lazy } from '@spinajs/util';

export enum QueryContext {
  Insert,
  Select,
  Update,
  Delete,
  Schema,
  Transaction,

  // Insert or UPDATE
  Upsert,
}

export enum ColumnAlterationType {
  Add,
  Modify,
  Rename,
}

export interface ISupportedFeature {
  /**
   * DB events support
   * To execute tasks accoriding to schedule in DB.
   */
  events: boolean;
}

export interface IRelation<R extends ModelBase<R>, O extends ModelBase<O>> extends Array<R> {
  TargetModelDescriptor: IModelDescriptor;

  /**
   * Indicates if data was fetched  from db
   */
  Populated: boolean;

  /**
   * Removes all objects from relation by comparison functions
   *
   * @param compare function to compare models
   */
  remove(compare: (a: R) => boolean): R[];

  /**
   * Removes all objects by primary key
   *
   * @param obj - data to remove
   */
  remove(obj: R | R[]): R[];

  /**
   * Removes from relation & deletes from db
   *
   * @param obj - data to remove
   */
  remove(obj: R | R[] | ((a: R, b: R) => boolean)): R[];

  /**
   * Delete all objects from relation ( alias for empty )
   */
  clear(): Promise<void>;

  /**
   * Clears relation data
   */
  empty(): void;

  /**
   * Synchronize relation data with db
   * NOTE: it removes data from db that are not in relation
   *
   * @param obj - object to add
   * @param mode - insert mode
   */
  sync(): Promise<void>;

  /**
   *
   * Calculates intersection between data in this relation and provided dataset
   * It saves result to db
   *
   * @param dataset - dataset to compare
   * @param callback - function to compare models, if not set it is compared by primary key value
   */
  intersection(dataset: R[], callback?: (a: R, b: R) => boolean): R[];

  /**
   * Adds all items to this relation & adds to database
   *
   * @param dataset - data to add
   * @param mode - insert mode
   */
  union(dataset: R[], mode?: InsertBehaviour): void;

  /**
   *
   * Calculates difference between data in this relation and provides set. Result is saved to db.
   *
   * @param dataset - data to compare
   * @param callback - function to compare objects, if none provideded - primary key value is used
   */
  diff(dataset: R[], callback?: (a: R, b: R) => boolean): R[];

  /**
   *
   * Clears data and replace it with new dataset.
   *
   * @param dataset - data for replace.
   */
  set(obj: R[] | ((data: R[], pKey: string) => R[])): void;

  /**
   * Populates this relation ( loads all data related to owner of this relation)
   */
  populate(callback?: (this: ISelectQueryBuilder<this>) => void): Promise<void>;
}

export interface DbServerResponse {
  LastInsertId: number;
}
export abstract class ServerResponseMapper {
  public abstract read(response: any, pkName?: string): DbServerResponse;
}

export abstract class DefaultValueBuilder<T> {
  public Query: RawQuery;
  public Value: string | number;

  /**
   * fills by default with current date
   */
  public abstract date(): T;

  /**
   * fills by default with current datetime
   */
  public abstract dateTime(): T;

  /**
   * Fills column with default value
   *
   * @param val - value to fill
   */
  public abstract value(val: string | number): T;

  /**
   * Fills column with result of query provided
   *
   * @param query - raw query instance
   */
  public abstract raw(query: RawQuery): T;
}

export enum InsertBehaviour {
  /**
   * Ignores if primary key exists in db
   */
  InsertOrIgnore,

  /**
   * Updates entry if pk exists
   */
  InsertOrUpdate,

  /**
   * Replaces entry if pk exists
   */
  InsertOrReplace,

  None,
}

/**
 * Foreign key referential actions
 */
export enum ReferentialAction {
  Cascade = 'CASCADE',
  SetNull = 'SET NULL',
  Restrict = 'RESTRICT',
  NoAction = 'NO ACTION',
  SetDefault = 'SET DEFAULT',
}

/**
 * Transaction mode when migration DB
 */
export enum MigrationTransactionMode {
  /**
   * Migration is run whithout transaction
   */
  None,

  /**
   * On transaction for one migration - every migration has its own
   */
  PerMigration,
}

/**
 * Configuration options to set in configuration file and used in OrmDriver
 */
export interface IDriverOptions {
  /**
   * Max connections limit
   */
  PoolLimit?: number;

  /**
   * Database name associated with this connection
   */
  Database?: string;

  /**
   * User associatet with this connection
   */
  User?: string;

  /**
   * Password to database
   */
  Password?: string;

  /**
   * DB Host
   */
  Host?: string;

  /**
   * Connection port
   */
  Port?: number;

  /**
   * Connection encoding eg. utf-8
   */
  Encoding?: string;

  /**
   * Database filename eg. for Sqlite driver
   */
  Filename?: string;

  /**
   * Driver name eg. mysql, sqlite, mssql etc.
   */
  Driver: string;

  /**
   * Connection name for identification
   */
  Name: string;

  /**
   * Additional driver-specific options
   */
  Options?: any;

  /**
   * If this is set, database connection will be made by ssh tunnel
   */
  SSH?: {
    // ssh host
    Host: string;
    Port: number;

    // path to private key for ssh connection
    PrivateKey: string;
    User: string;
  };

  Migration?: {
    /**
     * Should run migration on startup
     */
    OnStartup?: boolean;

    /**
     * Migration table name, if not set default is spinajs_orm_migrations
     */
    Table?: string;

    /**
     * Migration transaction options
     */
    Transaction?: {
      /**
       * How to run migration - with or without transaction
       */
      Mode?: MigrationTransactionMode;
    };
  };

  /**
   * When building queries with auto generated tables & fields
   * we wrap them in special caharacter eg. $
   * Different sql engines allows different characters,
   * SQLITE & MYSQL allow to use $ in queries, but MSSQL its special characted used to create pseudocolumn
   *
   * Example: SELECT $users$.Name FROM users as $users$
   */
  AliasSeparator?: string;

  /**
   * Is this connection default. Later can be referenced under 'default' name
   * eg. @Connection('default')
   */
  DefaultConnection?: boolean;
}

export interface IMigrationDescriptor {
  /**
   * Whitch connection migration will be executed
   */
  Connection: string;
}

export interface IValueConverterDescriptor {
  Class: Constructor<ValueConverter>;
  Options?: any;
}

/**
 * Describes model, used internally
 */
export interface IModelDescriptor {
  /**
   * Primary key name
   */
  PrimaryKey: string;

  /**
   * Connection name, must be avaible in db config
   */
  Connection: string;

  /**
   * Table name in database for this model
   */
  TableName: string;

  /**
   * Optional, describes timestamps in model
   */
  Timestamps: IModelTimestampDescriptor;

  /**
   * Optional, describes soft delete
   */
  SoftDelete: IModelSoftDeleteDescriptor;

  /**
   * Optional, is archive mode enabled
   */
  Archived: IModelArchivedDescriptor;

  /**
   * Column  / fields list in model
   */
  Columns: IColumnDescriptor[];

  /**
   * Converters attached to fields
   */
  Converters: Map<string, IValueConverterDescriptor>;

  /**
   * List of unique columns ( UNIQUE constraint )
   */
  JunctionModelProperties: IJunctionProperty[];

  /**
   * List of relations in model
   */
  Relations: Map<string, IRelationDescriptor>;

  /** Name of model */
  Name: string;

  /**
   * Model discrimination map that  allows to create different models based on db field value
   */
  DiscriminationMap: IDiscriminationMap;

  /**
   * Orm driver that this model
   */
  Driver: OrmDriver;

  /**
   * Json schema for validation
   */
  Schema: any;
}

export interface IDiscriminationMap {
  /**
   * DB field that holds inheritance value
   */
  Field: string;

  /**
   * Field values mapped for proper models
   */
  Models: Map<string, Constructor<ModelBase>>;
}

export interface IDiscriminationEntry {
  Key: string;
  Value: Constructor<ModelBase>;
}

export enum RelationType {
  One,
  Many,
  ManyToMany,
  Query
}

export type ForwardRefFunction = () => Constructor<ModelBase>;

/**
 * Returns result of last insert or affected rows ( eg. rows affected would be 0 if insert is ignored )
 */
export interface IUpdateResult {
  RowsAffected: number;
  LastInsertId: number;
}

export interface IRelationDescriptor {
  /**
   * Name of relations, defaults for property name in model that owns relation
   */
  Name: string;

  /**
   * Is it one-to-one, one-to-many or many-to-many
   */
  Type: RelationType;

  TargetModelType: Constructor<ModelBase> | ForwardRefFunction | string;

  /**
   * Relation model (  foreign )
   */
  TargetModel: Constructor<ModelBase> & IModelStatic;

  /**
   * Relation owner
   */
  SourceModel: Constructor<ModelBase> & IModelStatic;

  /**
   * Relation foreign key (one to one, one to many)
   */
  ForeignKey: string;

  /**
   * Relation primary key (one to one, one to many)
   */
  PrimaryKey: string;

  /**
   * Used in many to many relations, model for join table
   */
  JunctionModel?: Constructor<ModelBase>;

  /**
   * Join table foreign keys, defaults to auto generated field names. Can be override.
   */
  JunctionModelTargetModelFKey_Name?: string;
  JunctionModelSourceModelFKey_Name?: string;

  /**
   * Callback for returning query for relations. For use as custom relation queries
   * 
   * @param data fetched data to prepare relation eg. parent model to extract primary key
   * @returns 
   */
  Callback?: (data: ModelBase[]) => Promise<ISelectQueryBuilder>

  /**
   * When using custom @Quuery relation, this function is used to map retrieved data to model
   * @param data 
   * @returns 
   */
  Mapper?: (owner: ModelBase, data: ModelBase[]) => ModelBase | ModelBase[];

  JoinMode?: 'LeftJoin' | 'RightJoin';

  /**
   * Is this relation recursive ? Used for hierarchical / paren one-to-one relations
   */
  Recursive: boolean;

  /**
   * Relation factory, sometimes we dont want to create standard relation object
   */
  Factory?: (model: ModelBase<unknown>, relation: IRelationDescriptor, container: IContainer, data: any[]) => Relation<ModelBase<unknown>, ModelBase<unknown>>;

  /**
   *  sometimes we dont want to create standard relation object, so we create type
   *  that is passed in this property
   */
  RelationClass?: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>>> | (() => Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>>>);
}

export interface IModelStatic extends Constructor<ModelBase<unknown>> {
  where<T extends typeof ModelBase>(val: boolean): ISelectQueryBuilder<Array<InstanceType<T>>>;
  where<T extends typeof ModelBase>(val: PartialArray<InstanceType<T>> | PickRelations<T>): ISelectQueryBuilder<Array<InstanceType<T>>>;
  where<T extends typeof ModelBase>(func: WhereFunction<InstanceType<T>>): ISelectQueryBuilder<Array<InstanceType<T>>>;
  where<T extends typeof ModelBase>(column: string, operator: Op, value: any): ISelectQueryBuilder<Array<InstanceType<T>>>;
  where<T extends typeof ModelBase>(column: string, value: any): ISelectQueryBuilder<Array<InstanceType<T>>>;
  where<T extends typeof ModelBase>(statement: Wrap): ISelectQueryBuilder<Array<InstanceType<T>>>;
  where<T extends typeof ModelBase>(column: string | boolean | WhereFunction<InstanceType<T>> | RawQuery | PartialArray<InstanceType<T>> | Wrap | PickRelations<T>, operator?: Op | any, value?: any): ISelectQueryBuilder<Array<InstanceType<T>>>;
  where<T extends typeof ModelBase>(column: string | boolean | WhereFunction<InstanceType<T>> | RawQuery | PartialArray<InstanceType<T>> | Wrap | PickRelations<T>, _operator?: Op | any, _value?: any): ISelectQueryBuilder<Array<InstanceType<T>>>;
  destroy<T extends typeof ModelBase>(pk?: any | any[]): IDeleteQueryBuilder<InstanceType<T>> & Promise<IUpdateResult>;
  create<T extends typeof ModelBase>(data: Partial<InstanceType<T>>): Promise<InstanceType<T>>;
  query<T extends typeof ModelBase>(): ISelectQueryBuilder<Array<InstanceType<T>>>;
  count<T extends typeof ModelBase>(callback?: (builder: IWhereBuilder<T>) => void): Promise<number>;
  count(): Promise<number>;
  update<T extends typeof ModelBase>(data: Partial<InstanceType<T>>): IUpdateQueryBuilder<InstanceType<T>>;
  exists(pk: any): Promise<boolean>;
  get<T extends typeof ModelBase>(pk: any): Promise<InstanceType<T>>;
  insert<T extends typeof ModelBase>(data: InstanceType<T> | Partial<InstanceType<T>> | Array<InstanceType<T>> | Array<Partial<InstanceType<T>>>, insertBehaviour?: InsertBehaviour): Promise<IUpdateResult>;

  getModelDescriptor(): IModelDescriptor;
  getRelationDescriptor(relation: string): IRelationDescriptor;

  whereExists<R extends typeof ModelBase, T extends typeof ModelBase>(relation: string, func: WhereFunction<InstanceType<R>>): ISelectQueryBuilder<Array<InstanceType<T>>>;
  whereExists<T extends typeof ModelBase>(query: ISelectQueryBuilder<T>): ISelectQueryBuilder<Array<InstanceType<T>>>;
  whereNotExists<R extends typeof ModelBase, T extends typeof ModelBase>(relation: string, func: WhereFunction<InstanceType<R>>): ISelectQueryBuilder<Array<InstanceType<T>>>;
  whereNotExists<T extends typeof ModelBase>(query: ISelectQueryBuilder<T>): ISelectQueryBuilder<Array<InstanceType<T>>>;

  /**
   * Gets schema for filter columns of this model
   */
  filterSchema(): object;

  /**
   * Get list of filterable columns
   */
  filterColumns(): {
    column: string;
    operators: string[];
  };
}

export interface IModelBase {
  ModelDescriptor: IModelDescriptor;
  Container: IContainer;
  PrimaryKeyName: string;
  PrimaryKeyValue: any;

  /**
   * Marks model as dirty. It means that model have unsaved changes
   */
  IsDirty: boolean;

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
   * Extracts all data from model. It takes only properties that exists in DB. Does not dehydrate related data.
   *
   * @param omit - fields to omit
   */
  dehydrate(options?: IDehydrateOptions): ModelData<this>;

  /**
   *
   * Extracts all data from model with relation data. Relation data are dehydrated recursively.
   *
   * @param omit - fields to omit
   */
  dehydrateWithRelations(options?: IDehydrateOptions): ModelDataWithRelationData<this>;

  /**
   * deletes enitt from db. If model have SoftDelete decorator, model is marked as deleted
   */
  destroy(): Promise<IUpdateResult>;
  /**
   * If model can be in achived state - sets archived at date and saves it to db
   */
  archive(): Promise<IUpdateResult>;

  /**
   * Updates model to db
   */
  update(): Promise<IUpdateResult>;

  /**
   * Save all changes to db. It creates new entry id db or updates existing one if
   * primary key exists
   */
  insert(insertBehaviour: InsertBehaviour): Promise<IUpdateResult>;

  /**
   *
   * Shorthand for inserting model when no primary key exists, or update
   * its value in db if primary key is set
   */
  insertOrUpdate(): Promise<IUpdateResult>;

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

  /**
   * Used for JSON serialization
   */
  toJSON(): any;

  driver(): OrmDriver;
}

export interface IJunctionProperty {
  Name: string;

  Model: Constructor<ModelBase>;
}

/**
 * Table column description, used in models to build schema, validate & other stuff
 */
export interface IColumnDescriptor {
  /**
   * Columnt  type eg int, varchar, text
   */
  Type: string;

  /**
   * Max character lenght handled in column
   */
  MaxLength: number;

  /**
   * Column comment, use it for documentation purposes.
   */
  Comment: string;

  /**
   * Default column value
   */
  DefaultValue: any;

  /**
   * Full database type with size/length info & sign eg. int(10) unsigned if avaible
   */
  NativeType: string;

  /**
   * Numeric types sign
   */
  Unsigned: boolean;

  /**
   * Is column nullable (can be null)
   */
  Nullable: boolean;

  /**
   * Is column primary key
   */
  PrimaryKey: boolean;

  /**
   * Is column auto increment
   */
  AutoIncrement: boolean;

  /**
   * Column name
   */
  Name: string;

  /**
   * Value converter between database & model
   */
  Converter: IValueConverter;

  /**
   * JSON schema definition build for this column. Used to automate data validation
   */
  Schema: any;

  /**
   * Does have unique constraint
   */
  Unique: boolean;

  /**
   * Is uuid generated column
   */
  Uuid: boolean;

  // should be skipped when serializing to json
  Ignore: boolean;

  /**
   * Is column generated eg. sum,min,max & group by
   */
  Aggregate: boolean;

  /**
   * Is column virtual ( not exists in DB )
   */
  Virtual: boolean;

  // is this column a foreign key
  IsForeignKey: boolean;

  ForeignKeyDescription: {
    From: string;
    To: string;
    Table: string;
  };
}

/**
 * Value converter between model & database data types
 */
export interface IValueConverter {
  /**
   * Converts value to database type
   *
   * @param value - value to convert
   */
  toDB(value: any, model: ModelBase, column: IColumnDescriptor, options: any, dehydrateOptions?: IDehydrateOptions): any;

  /**
   * Converts value from database type eg. mysql timestamp to DateTime
   *
   * @param value - value to convert
   */
  fromDB(value: any, rawData: any, options: any): any;
}

/**
 * Model timestamps description
 */
export interface IModelTimestampDescriptor {
  /**
   * Created at column name
   */
  CreatedAt: string;

  /**
   * Updated at column name
   */
  UpdatedAt: string;
}

/**
 * Model soft delete description
 */
export interface IModelSoftDeleteDescriptor {
  /**
   * Deleted at column name
   */
  DeletedAt: string;
}

@NewInstance()
export abstract class OrmMigration {
  /**
   *
   * Migrate up - create tables, indices etc.
   * Be aware that model function are not avaible yet. To fill tables with
   * data use fill function
   */
  public abstract up(connection: OrmDriver): Promise<void>;

  /**
   * Migrate down - undo changes made in up
   */
  public abstract down(connection: OrmDriver): Promise<void>;

  /**
   * Migrate data - execute AFTER orm module has been initialized
   *
   * It means that all model & relations are avaible
   */
  public async data(): Promise<void> { }
}

/**
 * Model archived description
 */
export interface IModelArchivedDescriptor {
  /**
   * Archived at column name
   */
  ArchivedAt: string;
}

export interface IQueryLimit {
  limit?: number;
  offset?: number;
}

export interface ISort {
  column: string;
  order: SortOrder;
}

export interface IQueryBuilder {
  Table: string;
  TableAlias: string;
  Database: string;
  database(database: string): IQueryBuilder;
  from(table: string, alias?: string): this;
  setAlias(alias: string): this;

  Driver: OrmDriver;
  Container: IContainer;
}

export interface ILimitBuilder<T> {
  take(count: number): this;
  skip(count: number): this;
  first(): Promise<Unbox<T>>;
  takeFirst(): this;
  firstOrFail(): Promise<Unbox<T>>;
  firstOrThrow(error: Error): Promise<Unbox<T>>;
  orThrow(error: Error): Promise<Unbox<T>>;
  getLimits(): IQueryLimit;
}

export interface IOrderByBuilder {
  orderBy(column: string): this;
  orderByDescending(column: string): this;
  order(column: string, direction: SortOrder): this;
  getSort(): ISort;
}

export interface IColumnsBuilder {
  /**
   * clears selected columns
   */
  clearColumns(): this;

  /**
   *
   * Select columns from db result ( multiple at once )
   *
   * @param names - column names to select
   */
  columns(names: string[]): this;

  /**
   * Return selected columns in this query
   */
  getColumns(): IQueryStatement[];

  /**
   * Selects single column from DB result with optional alias
   * Can be used multiple times
   *
   * @param column - column to select
   * @param alias - column alias ( optional )
   */
  select(column: string, alias?: string): this;

  /**
   * Selects custom values from DB. eg. Count(*)
   *
   * @param rawQuery - raw query to be executed
   */
  select(rawQuery: RawQuery): this;

  /**
   * Selects multiple columns at once with aliases. Map key property is column name, value is its alias
   *
   * @param columns - column list with aliases
   */
  // tslint:disable-next-line: unified-signatures
  select(columns: Map<string, string>): this;
}

export interface IWhereBuilder<T> {
  Statements: IQueryStatement[];

  Op: WhereBoolean;

  clone(): IWhereBuilder<T>;

  when(condition: boolean, callback?: WhereFunction<T>, callbackElse?: WhereFunction<T>): this;

  where(val: boolean): this;
  where(val: Partial<ModelDataWithRelationDataSearchable<Unbox<T>>>): this;
  where(func: WhereFunction<T>): this;
  where(func: Lazy<void>): this;
  where(column: string, operator: Op, value: any): this;
  where(column: string, value: any): this;
  where(statement: Wrap): this;
  where(column: string | boolean | WhereFunction<T> | Lazy<void> | RawQuery | Partial<ModelDataWithRelationDataSearchable<Unbox<T>>> | Wrap, operator?: Op | any, value?: any): this;

  orWhere(val: boolean): this;
  orWhere(val: Partial<ModelDataWithRelationDataSearchable<Unbox<T>>>): this;
  orWhere(func: WhereFunction<T>): this;
  orWhere(func: Lazy<void>): this;
  orWhere(column: string, operator: Op, value: any): this;
  orWhere(column: string, value: any): this;
  orWhere(statement: Wrap): this;
  orWhere(column: string | boolean | WhereFunction<T> | RawQuery | Wrap | Partial<ModelDataWithRelationDataSearchable<Unbox<T>>>, operator?: Op | any, value?: any): this;

  andWhere(val: boolean): this;
  andWhere(val: Partial<ModelDataWithRelationDataSearchable<Unbox<T>>>): this;
  andWhere(func: WhereFunction<T>): this;
  andWhere(func: Lazy<void>): this;
  andWhere(column: string, operator: Op, value: any): this;
  andWhere(column: string, value: any): this;
  andWhere(statement: Wrap): this;
  andWhere(column: string | boolean | Lazy<void> | WhereFunction<T> | RawQuery | Wrap | Partial<ModelData<Unbox<T>>>, operator?: Op | any, value?: any): this;

  whereObject(obj: Partial<ModelData<Unbox<T>>>): this;
  whereNotNull(column: string): this;
  whereNull(column: string): this;
  whereNot(column: string, val: unknown): this;
  whereIn(column: string, val: unknown[]): this;
  whereNotIn(column: string, val: unknown[]): this;
  whereExist<R>(query: ISelectQueryBuilder | string, callback?: WhereFunction<R>): this;
  whereNotExists<R>(query: ISelectQueryBuilder | string, callback?: WhereFunction<R>): this;
  whereBetween(column: string, val: unknown[]): this;
  whereNotBetween(column: string, val: unknown[]): this;
  whereInSet(column: string, val: unknown[]): this;
  whereNotInSet(column: string, val: unknown[]): this;
  clearWhere(): this;
}

export interface IWithRecursiveBuilder {
  CteRecursive: IQueryStatement;

  withRecursive(recKeyName: string, pkKeyName: string): this;
}

export interface IGroupByBuilder {
  GroupStatements: IQueryStatement[];

  clearGroupBy(): this;
  groupBy(expression: RawQuery | string): this;
}

/**
 * Dummy abstract class for allowing to add extensions for builder via declaration merging & mixins
 */
//@ts-ignore
export interface ISelectBuilderExtensions<T> { }

export interface IJoinBuilder {
  JoinStatements: IQueryStatement[];

  clearJoins(): this;

  innerJoin(query : RawQuery): this;
  innerJoin<R = ModelBase>(relation: string, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;
  innerJoin<R = ModelBase>(model: Constructor<ModelBase>, callback?: (this: IWhereBuilder<R>, queryCallback?: (this: ISelectQueryBuilder<R>) => void) => void): this;
  innerJoin<R = ModelBase>(options: IJoinStatementOptions<R>): this;

  leftJoin(expression: RawQuery): this;
  leftJoin<R = ModelBase>(options: IJoinStatementOptions<R>): this;
  leftJoin<R = ModelBase>(relation: string, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;
  leftJoin<R = ModelBase>(model: Constructor<ModelBase>, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;

  leftOuterJoin(query : RawQuery): this;
  leftOuterJoin<R = ModelBase>(options: IJoinStatementOptions<R>): this;
  leftOuterJoin<R = ModelBase>(relation: string, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;
  leftOuterJoin<R = ModelBase>(model: Constructor<ModelBase>, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;

  rightJoin(expression: RawQuery): this;
  rightJoin<R = ModelBase>(options: IJoinStatementOptions<R>): this;
  rightJoin<R = ModelBase>(relation: string, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;
  rightJoin<R = ModelBase>(model: Constructor<ModelBase>, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;


  rightOuterJoin(expression: RawQuery): this;
  rightOuterJoin<R = ModelBase>(options: IJoinStatementOptions<R>): this;
  rightOuterJoin<R = ModelBase>(relation: string, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;
  rightOuterJoin<R = ModelBase>(model: Constructor<ModelBase>, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;

  fullOuterJoin(expression: RawQuery): this;
  fullOuterJoin<R = ModelBase>(options: IJoinStatementOptions<R>): this;
  fullOuterJoin<R = ModelBase>(relation: string, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;
  fullOuterJoin<R = ModelBase>(model: Constructor<ModelBase>, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;

  crossJoin(expression: RawQuery): this;
  crossJoin<R = ModelBase>(options: IJoinStatementOptions<R>): this;
  crossJoin<R = ModelBase>(relation: string, callback?: (this: IWhereBuilder<R>) => void, queryCallback?: (this: ISelectQueryBuilder<R>) => void): this;
  crossJoin<R = ModelBase>(model: Constructor<ModelBase>, callback?: (this: IWhereBuilder<R>, queryCallback?: (this: ISelectQueryBuilder<R>) => void) => void): this;

  join<R = ModelBase>(method: JoinMethod, expression: RawQuery): this;
  join<R = ModelBase>(method: JoinMethod, relation: string, callback?: (this: IWhereBuilder<R>, queryCallback?: (this: ISelectQueryBuilder<R>) => void) => void): this;
  join<R = ModelBase>(method: JoinMethod, model: Constructor<ModelBase>, callback?: (this: IWhereBuilder<R>, queryCallback?: (this: ISelectQueryBuilder<R>) => void) => void): this;
  join<R = ModelBase>(method: JoinMethod, options: IJoinStatementOptions<R>): this;
}

export interface IBuilder<T> extends PromiseLike<T> {
  middleware(middleware: IBuilderMiddleware<T>): this;
  toDB(): ICompilerOutput | ICompilerOutput[];
}

export interface IUpdateQueryBuilder<T> extends IColumnsBuilder, IWhereBuilder<T> { }

export interface IDeleteQueryBuilder<T> extends IWhereBuilder<T>, ILimitBuilder<T> { }

export interface ISelectQueryBuilder<T = unknown> extends IColumnsBuilder, IOrderByBuilder, ILimitBuilder<T>, IWhereBuilder<T>, IJoinBuilder, IWithRecursiveBuilder, IGroupByBuilder, IQueryBuilder, IBuilder<T> {
  get Relations(): IOrmRelation[];

  min(column: string, as?: string): this;
  max(column: string, as?: string): this;
  count(): Promise<number>;
  count(column: string, as?: string): Promise<number>;
  sum(column: string, as?: string): this;
  avg(column: string, as?: string): this;
  setAlias(alias: string): this;
  setTable(table: string, alias?: string): this;
  distinct(): this;
  clone(): this;

  /**
   * Returns true/false if query result exists in db
   */
  resultExists(): Promise<boolean>;
  populate<R = this>(relation: string[]): this;
  populate<R = this>(relation: {}, callback?: (this: ISelectQueryBuilder<R>, relation: IOrmRelation) => void): this;
  populate<R = this>(relation: string, callback?: (this: ISelectQueryBuilder<R>, relation: IOrmRelation) => void): this;
  asRaw<T>(): Promise<T>;
  /**
   * Returns all records. Its for type castin when using with scopes mostly.
   */
  all(): Promise<T[]>;

  mergeBuilder(builder: ISelectQueryBuilder): void;
}

export interface ICompilerOutput {
  expression: string;
  bindings: any[];
}

export interface IQueryCompiler {
  compile(): ICompilerOutput | ICompilerOutput[];
}

export interface ILimitCompiler {
  limit(builder: ILimitBuilder<any>): ICompilerOutput;
}

export interface IGroupByCompiler {
  group(builder: IGroupByBuilder): ICompilerOutput;
}

export interface IRecursiveCompiler {
  recursive(builder: IWithRecursiveBuilder): ICompilerOutput;
}

export interface IColumnsCompiler {
  columns(builder: IColumnsBuilder): ICompilerOutput;
}

export interface IWhereCompiler {
  where(builder: IWhereBuilder<any>): ICompilerOutput;
}

export interface IHavingCompiler {
  having(builder: IWhereBuilder<any>): ICompilerOutput;
}

export interface IJoinCompiler {
  join(builder: IJoinBuilder): ICompilerOutput;
}

/**
 *  Definitions of query compiler are needed for DI resolving
 * ==========================================================
 */
@NewInstance()
export abstract class RecursiveQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}
@NewInstance()
export abstract class SelectQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class JoinQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class IndexQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class LimitQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class ForeignKeyQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class DeleteQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class UpdateQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class InsertQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class OnDuplicateQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class TableQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput[] | ICompilerOutput;
}

@NewInstance()
export abstract class TableHistoryQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput[];
}

@NewInstance()
export abstract class TruncateTableQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class TableCloneQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput[];
}

@NewInstance()
export abstract class EventQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput[];
}

@NewInstance()
export abstract class DropEventQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput[];
}

@NewInstance()
export abstract class AlterTableQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput[];
}

@NewInstance()
export abstract class TableExistsCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class DropTableCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class ColumnQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class AlterColumnQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class OrderByQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export abstract class GroupByQueryCompiler implements IQueryCompiler {
  public abstract compile(): ICompilerOutput;
}

/**
 * ==========================================================
 */

/**
 * Middlewares for query builders
 */
export interface IBuilderMiddleware<T = any[]> {
  /**
   *
   * Executed AFTER query is executed in DB and raw data is fetched
   * Use it to transform DB data before everything else
   *
   * @param data - raw data fetched from DB
   */
  afterQuery(data: T): T;

  /**
   * Executed when model is about to create. Use it to
   * override model creation logic. If null is returned, default model
   * is executed
   *
   * @param data - raw data to create
   */
  modelCreation(data: any): ModelBase;

  /**
   * executed after model was created ( all returned data by query is executed)
   *
   * @param data - hydrated data. Models are created and hydrated with data
   */
  afterHydration(data: ModelBase[]): Promise<any[] | void>;
}

export abstract class QueryMiddleware {
  abstract afterQueryCreation(query: QueryBuilder): void;
  abstract beforeQueryExecution(query: QueryBuilder): void;
}

export abstract class ModelMiddleware {
  abstract onDelete(model: ModelBase): Promise<void>;
  abstract onUpdate(model: ModelBase): Promise<void>;
  abstract onInsert(model: ModelBase): Promise<void>;
  abstract onSelect(model: ModelBase): Promise<void>;
}

export class ValueConverter implements IValueConverter {
  /**
   * Converts value to database type
   *
   * @param value - value to convert
   */
  public toDB(_value: any, _model: ModelBase<any>, _column: IColumnDescriptor, _options?: any, _dehydrateOptions?: IDehydrateOptions): any {
    throw new MethodNotImplemented();
  }

  /**
   * Converts value from database type eg. mysql timestamp to DateTime
   *
   * @param value - value to convert
   */
  public fromDB(_value: any, _rawData?: any, _options?: any): any {
    throw new MethodNotImplemented();
  }
}

/**
 * Converter for DATETIME field (eg. mysql datetime)
 */
export class DatetimeValueConverter extends ValueConverter { }

/**
 * Convert 0/1 to boolean ( mysql, sqlite etc.  use 0/1 for boolean fields and tinyint/bit types )
 */
export class BooleanValueConverter extends ValueConverter { }

/**
 * Converter for set field (eg. mysql SET)
 */
export class SetValueConverter extends ValueConverter { }

@Singleton()
export abstract class TableAliasCompiler {
  public abstract compile(builder: QueryBuilder, tbl?: string): string;
}

export interface IUniversalConverterOptions {
  TypeColumn: string;
}

/**
 * base class for select & where builder for defining scopes
 */
export abstract class QueryScope { }

export interface IHistoricalModel {
  readonly __action__: 'insert' | 'update' | 'delete';
  readonly __revision__: number;
  readonly __start__: DateTime;
  readonly __end__: DateTime;
}

export abstract class ModelToSqlConverter {
  public abstract toSql(model: ModelBase<unknown>): unknown;
}

export abstract class ObjectToSqlConverter {
  public abstract toSql(model: unknown, descriptor: IModelDescriptor): unknown;
}


export interface IDehydrateOptions {
  /**
   * Fields to not include in dehydrate
   */
  omit?: string[];

  /**
   * Should skip null values in dehydrate
   */
  skipNull?: boolean;

  /**
   * Should skip undefined values in dehydrate
   */
  skipUndefined?: boolean;

  /**
   * Should skip empty arrays in dehydrate
   */
  skipEmptyArray?: boolean;

  /**
   * Do not throw error if model has nullable fields and they are not set
   */
  ignoreNullable?: boolean;

  /**
   * Datetime format to use when dehydrate DateTime fields
   * - iso - ISO 8601 format
   * - sql - SQL format (YYYY-MM-DD HH:MM:SS)
   * - unix - Unix timestamp (seconds since epoch)
   */
  dateTimeFormat?: 'iso' | 'sql' | 'unix';
}

export interface IJoinStatementOptions<R = ModelBase> {

  /**
   * Query builder that is creating this join
   */
  builder?: ISelectQueryBuilder;

  /**
   * Join method eg. inner, left, right
   */
  method?: JoinMethod;

  /**
   * Joined table name if not using model
   */
  joinTable?: string;

  /**
   * Join table alias if not using model
   */
  joinTableAlias?: string;

  /**
   * Join table foreign key ( eg. users.id = posts.user_id -> user_id is foreign key )
   */
  joinTableForeignKey?: string;

  /**
   * Joined model. Is used - it searches for relation between source model & joined model
   * and extract all needed data
   */
  joinModel?: Constructor<ModelBase>;

  /**
   * 
   */
  sourceModel?: Constructor<ModelBase>;

  /**
   * Source model - model that is creating this join
   * If not using builder or raw query
   */
  sourceTableAlias?: string;
  /**
   * Source table primary key ( eg. users.id = posts.user_id -> id is primary key )
   * If not using model, its needed to set this property
   */
  sourceTablePrimaryKey?: string;

  /** Source table database if not using builder */
  sourceTableDatabase?: string;

  /** Join table database if not using model */
  joinTableDatabase?: string;

  /**
   * Raw query join
   */
  query?: RawQuery;

  /**
   * Optional callback to further modify join query ( wheres )
   * 
   * @param this callback context is where builder for this join. It will preseve aliases etc.
   */
  callback?: ((this: IWhereBuilder<R>) => void) | Lazy<(this: ISelectQueryBuilder<R>) => void>;

  /**
   * 
   * Optional callback to modify whole join query builder
   * 
   * @param this callback context is select query builder for this join
   * @returns 
   */
  queryCallback?: (this: ISelectQueryBuilder<R>) => void;
}