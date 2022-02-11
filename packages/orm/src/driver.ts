import { Log } from '@spinajs/log';
/* eslint-disable prettier/prettier */
import { QueryContext } from './interfaces';
import { SyncModule, IContainer, DI, Container, Autoinject } from '@spinajs/di';
import { IDriverOptions, IColumnDescriptor } from '.';
import { UpdateQueryBuilder, SelectQueryBuilder, IndexQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder, SchemaQueryBuilder, QueryBuilder } from './builders';
import { ModelHydrator, DbPropertyHydrator, OneToOneRelationHydrator, NonDbPropertyHydrator, JunctionModelPropertyHydrator } from './hydrators';

export type TransactionCallback = (driver: OrmDriver) => Promise<any>;

export abstract class OrmDriver extends SyncModule {
  /**
   * Connection options
   */
  public Options: IDriverOptions;

  @Autoinject()
  protected RootContainer: Container;

  protected Log: Log;

  public Container: IContainer;

  constructor(options: IDriverOptions) {
    super();

    this.Options = options;
  }

  /**
   * Executes query on database
   *
   * @param stmt - query string or query objects that is executed in database
   * @param params - binding parameters
   * @param context - query context to optimize queries sent to DB
   */
  public abstract execute(stmt: string | object, params: any[], context: QueryContext): Promise<any[] | any>;

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

    /**
     * Hydrators are registered globally
     */
    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(OneToOneRelationHydrator).as(ModelHydrator);
    DI.register(JunctionModelPropertyHydrator).as(ModelHydrator);
  }

  /**
   * Creates select query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public select(): SelectQueryBuilder {
    return this.Container.resolve(SelectQueryBuilder, [this]);
  }

  /**
   * Creates delete query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public del(): DeleteQueryBuilder {
    return this.Container.resolve(DeleteQueryBuilder, [this]);
  }

  /**
   * Creates insert query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public insert(): InsertQueryBuilder {
    return this.Container.resolve(InsertQueryBuilder, [this]);
  }

  /**
   * Creates update query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public update(): UpdateQueryBuilder {
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
