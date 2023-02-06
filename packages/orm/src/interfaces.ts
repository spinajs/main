import { Op } from './enums.js';
/* eslint-disable prettier/prettier */
import { QueryBuilder, RawQuery } from './builders.js';
import { SortOrder, WhereBoolean } from './enums.js';
import { IQueryStatement, Wrap } from './statements.js';
import { PartialArray, PartialModel, Unbox, WhereFunction } from './types.js';
import { Relation, IOrmRelation } from './relations.js';
import { OrmDriver } from './driver.js';
import { NewInstance, Constructor, Singleton, IContainer } from '@spinajs/di';
import { ModelBase } from './model.js';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

export enum QueryContext {
  Insert,
  Select,
  Update,
  Delete,
  Schema,
  Transaction,
}

export enum ColumnAlterationType {
  Add,
  Modify,
  Rename,
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
  TargetModel: Constructor<ModelBase>;

  /**
   * Relation owner
   */
  SourceModel: Constructor<ModelBase>;

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
   * Is this relation recursive ? Used for hierarchical / paren one-to-one relations
   */
  Recursive: boolean;

  /**
   * Relation factory, sometimes we dont want to create standard relation object
   */
  Factory?: (model: ModelBase<unknown>, relation: IRelationDescriptor, container: IContainer) => Relation<ModelBase<unknown>, ModelBase<unknown>>;

  /**
   *  sometimes we dont want to create standard relation object, so we create type
   *  that is passed in this property
   */
  RelationClass?: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>>>;
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
  toDB(value: any, model: ModelBase, options: any): any;

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
  firstOrFail(): Promise<Unbox<T>>;
  firstOrThrow(error: Error): Promise<Unbox<T>>;
  orThrow(error: Error): Promise<Unbox<T>>;
  getLimits(): IQueryLimit;
}

export interface IOrderByBuilder {
  orderBy(column: string): this;
  orderByDescending(column: string): this;
  order(column: string, direction: 'ASC' | 'DESC'): this;
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

  where(val: boolean): this;
  where(val: PartialArray<PartialModel<T>>): this;
  where(func: WhereFunction<T>): this;
  where(column: string, operator: Op, value: any): this;
  where(column: string, value: any): this;
  where(statement: Wrap): this;
  where(column: string | boolean | WhereFunction<T> | RawQuery | PartialArray<PartialModel<T>> | Wrap, operator?: Op | any, value?: any): this;

  orWhere(val: boolean): this;
  orWhere(val: PartialArray<PartialModel<T>>): this;
  orWhere(func: WhereFunction<T>): this;
  orWhere(column: string, operator: Op, value: any): this;
  orWhere(column: string, value: any): this;
  orWhere(statement: Wrap): this;
  orWhere(column: string | boolean | WhereFunction<T> | RawQuery | Wrap | PartialArray<PartialModel<T>>, operator?: Op | any, value?: any): this;

  andWhere(val: boolean): this;
  andWhere(val: PartialArray<PartialModel<T>>): this;
  andWhere(func: WhereFunction<T>): this;
  andWhere(column: string, operator: Op, value: any): this;
  andWhere(column: string, value: any): this;
  andWhere(statement: Wrap): this;
  andWhere(column: string | boolean | WhereFunction<T> | RawQuery | Wrap | PartialArray<PartialModel<T>>, operator?: Op | any, value?: any): this;

  whereObject(obj: any): this;
  whereNotNull(column: string): this;
  whereNull(column: string): this;
  whereNot(column: string, val: any): this;
  whereIn(column: string, val: any[]): this;
  whereNotIn(column: string, val: any[]): this;
  whereExist(query: ISelectQueryBuilder<T>): this;
  whereNotExists(query: ISelectQueryBuilder<T>): this;
  whereBetween(column: string, val: any[]): this;
  whereNotBetween(column: string, val: any[]): this;
  whereInSet(column: string, val: any[]): this;
  whereNotInSet(column: string, val: any[]): this;
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
export interface ISelectBuilderExtensions<T> {}

export interface IJoinBuilder {
  JoinStatements: IQueryStatement[];

  clearJoins(): this;

  innerJoin<M extends ModelBase>(model: Constructor<M>, where?: (this: ISelectQueryBuilder<M>) => void): this;
  innerJoin(query: RawQuery): this;
  innerJoin(table: string, foreignKey: string, primaryKey: string): this;
  // tslint:disable-next-line: unified-signatures
  innerJoin(table: string, tableAlias: string, foreignKey: string, primaryKey: string): this;

  leftJoin<M extends ModelBase>(model: Constructor<M>, where?: (this: ISelectQueryBuilder<M>) => void): this;
  leftJoin(query: RawQuery): this;
  leftJoin(table: string, foreignKey: string, primaryKey: string): this;

  // tslint:disable-next-line: unified-signatures
  leftJoin(table: string, tableAlias: string, foreignKey: string, primaryKey: string): this;

  leftOuterJoin<M extends ModelBase>(model: Constructor<M>, where?: (this: ISelectQueryBuilder<M>) => void): this;
  leftOuterJoin(query: RawQuery): this;
  leftOuterJoin(table: string, foreignKey: string, primaryKey: string): this;
  // tslint:disable-next-line: unified-signatures
  leftOuterJoin(table: string, tableAlias: string, foreignKey: string, primaryKey: string): this;

  rightJoin<M extends ModelBase>(model: Constructor<M>, where?: (this: ISelectQueryBuilder<M>) => void): this;
  rightJoin(query: RawQuery): this;
  rightJoin(table: string, foreignKey: string, primaryKey: string): this;
  // tslint:disable-next-line: unified-signatures
  rightJoin(table: string, tableAlias: string, foreignKey: string, primaryKey: string): this;

  rightOuterJoin<M extends ModelBase>(model: Constructor<M>, where?: (this: ISelectQueryBuilder<M>) => void): this;
  rightOuterJoin(query: RawQuery): this;
  rightOuterJoin(table: string, foreignKey: string, primaryKey: string): this;
  // tslint:disable-next-line: unified-signatures
  rightOuterJoin(table: string, tableAlias: string, foreignKey: string, primaryKey: string): this;

  fullOuterJoin<M extends ModelBase>(model: Constructor<M>, where?: (this: ISelectQueryBuilder<M>) => void): this;
  fullOuterJoin(query: RawQuery): this;
  fullOuterJoin(table: string, foreignKey: string, primaryKey: string): this;
  // tslint:disable-next-line: unified-signatures
  fullOuterJoin(table: string, tableAlias: string, foreignKey: string, primaryKey: string): this;

  crossJoin<M extends ModelBase>(model: Constructor<M>, where?: (this: ISelectQueryBuilder<M>) => void): this;
  crossJoin(query: RawQuery): this;
  crossJoin(table: string, foreignKey: string, primaryKey: string): this;
  // tslint:disable-next-line: unified-signatures
  crossJoin(table: string, tableAlias: string, foreignKey: string, primaryKey: string): this;
}

export interface IBuilder<T> extends PromiseLike<T> {
  middleware(middleware: IBuilderMiddleware<T>): this;
  toDB(): ICompilerOutput | ICompilerOutput[];
}

export interface ISelectQueryBuilder<T> extends IColumnsBuilder, IOrderByBuilder, ILimitBuilder<T>, IWhereBuilder<T>, IJoinBuilder, IWithRecursiveBuilder, IGroupByBuilder, IBuilder<T> {
  min(column: string, as?: string): this;
  max(column: string, as?: string): this;
  count(column: string, as?: string): this;
  sum(column: string, as?: string): this;
  avg(column: string, as?: string): this;
  distinct(): this;
  clone(): this;
  populate<R = this>(relation: string, callback?: (this: ISelectQueryBuilder<R>, relation: IOrmRelation) => void): this;

  /**
   * Returns all records. Its for type castin when using with scopes mostly.
   */
  all(): Promise<T[]>;
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
  public toDB(_value: any, _model: ModelBase<any>, _options: any): any {
    throw new MethodNotImplemented();
  }

  /**
   * Converts value from database type eg. mysql timestamp to DateTime
   *
   * @param value - value to convert
   */
  public fromDB(_value: any, _rawData: any, _options: any): any {
    throw new MethodNotImplemented();
  }
}

/**
 * Converter for DATETIME field (eg. mysql datetime)
 */
export class DatetimeValueConverter extends ValueConverter {}

export class JsonValueConverter extends ValueConverter {
  /**
   * Converts value to database type
   *
   * @param value - value to convert
   */
  public toDB(value: any): any {
    return JSON.stringify(value);
  }

  /**
   * Converts value from database type eg. mysql timestamp to DateTime
   *
   * @param value - value to convert
   */
  public fromDB(value: any): any {
    return JSON.parse(value);
  }
}

/**
 * Converter for set field (eg. mysql SET)
 */
export class SetValueConverter extends ValueConverter {}

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
export abstract class QueryScope {}

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
  public abstract toSql(model: unknown): unknown;
}
