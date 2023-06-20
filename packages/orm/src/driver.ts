import { Log } from '@spinajs/log-common';
/* eslint-disable prettier/prettier */
import { IColumnDescriptor, IDriverOptions, ModelToSqlConverter, ObjectToSqlConverter } from './interfaces.js';
import { SyncService, IContainer, DI, Container, Autoinject } from '@spinajs/di';
import { UpdateQueryBuilder, SelectQueryBuilder, IndexQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder, SchemaQueryBuilder, QueryBuilder, TruncateTableQueryBuilder, Builder } from './builders.js';
import { JsonValueConverter, StandardModelToSqlConverter, StandardObjectToSqlConverter, UniversalValueConverter, UuidConverter } from './converters.js';
import './hydrators.js';
import './dehydrators.js';

export type TransactionCallback = (driver: OrmDriver) => Promise<any>;

export abstract class OrmDriver<T extends IDriverOptions = IDriverOptions> extends SyncService {
  /**
   * Connection options
   */
  public Options: T = {
    AliasSeparator: '$',
    Driver: 'unknown',
    Name: 'orm-driver',
    DefaultConnection: false
  } as T;

  public Container: IContainer;

  @Autoinject()
  protected RootContainer: Container;

  protected Log: Log;

  constructor(options: T) {
    super();
    this.Options = Object.assign(this.Options, options);
  }

  /**
   * Executes query on database
   *
   * @param stmt - query string or query objects that is executed in database
   * @param params - binding parameters
   * @param context - query context to optimize queries sent to DB
   */
  //public abstract execute(stmt: string | object, params: any[], context: QueryContext): Promise<any[] | any>;
  public abstract execute(builder: Builder<any>): Promise<any[] | any>;

  /**
   * Checks if database is avaible
   * @returns false if cannot reach database
   */
  public abstract ping(): Promise<boolean>;

  /**
   * Connects to database
   * @throws OrmException if can't connec to to database
   */
  public abstract connect(): Promise<OrmDriver>;

  /**
   * Disconnects from database
   */
  public abstract disconnect(): Promise<OrmDriver>;

  public abstract tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]>;

  public resolve() {
    this.Log = DI.resolve(Log, [`orm-driver-${this.Options.Name}`]);
    this.Log.addVariable('orm-name', this.Options.Name);
    this.Log.addVariable('orm-host', this.Options.Host);
    this.Log.addVariable('orm-database', this.Options.Database);

    this.Container = this.RootContainer.child();
    this.Container.register(StandardModelToSqlConverter).as(ModelToSqlConverter);
    this.Container.register(StandardObjectToSqlConverter).as(ObjectToSqlConverter);
    this.Container.register(JsonValueConverter).as(JsonValueConverter);
    this.Container.register(UuidConverter).as(UuidConverter);
    this.Container.register(UniversalValueConverter).as(UniversalValueConverter);
  }

  /**
   * Creates select query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public select<T>(): SelectQueryBuilder<T> {
    return this.Container.resolve(SelectQueryBuilder, [this]) as SelectQueryBuilder<T>;
  }

  /**
   * Creates delete query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public del<T>(): DeleteQueryBuilder<T> {
    return this.Container.resolve(DeleteQueryBuilder, [this]) as DeleteQueryBuilder<T>;
  }

  /**
   * Creates insert query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public insert(): InsertQueryBuilder {
    return this.Container.resolve(InsertQueryBuilder, [this]);
  }

  /**
   * Truncates given table
   */
  public truncate(table: string): TruncateTableQueryBuilder {
    const b = this.Container.resolve(TruncateTableQueryBuilder, [this]);
    b.setTable(table);
    return b;
  }

  /**
   * Creates update query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public update<T>(): UpdateQueryBuilder<T> {
    return this.Container.resolve(UpdateQueryBuilder, [this]);
  }

  /**
   * Creates schema query builder associated with this connection.
   * This can be use to modify database structure
   */
  public schema(): SchemaQueryBuilder {
    return this.Container.resolve(SchemaQueryBuilder, [this]);
  }

  /**
   * Creates index query builder associated with this connection.
   * This can be use to create table indexes
   */
  public index(): IndexQueryBuilder {
    return this.Container.resolve(IndexQueryBuilder, [this]);
  }

  /**
   * Executes all queries in transaction
   *
   * @param queryOrCallback - one or more queries to execute in transaction scope. If parameter is function
   * its executed in transaction scope, thus all db operation in callback function are in transaction
   */
  public abstract transaction(queryOrCallback?: QueryBuilder[] | TransactionCallback): Promise<void>;
}
