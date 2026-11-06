import { Container, Inject, NewInstance } from '@spinajs/di';
import { RawSchemaQueryCompiler } from '../../interfaces.js';
import type { ICompilerOutput } from '../../interfaces.js';
import type { OrmDriver } from '../../driver.js';
import type { SchemaTouch } from '../../schema-touches.js';
import { RawQuery } from '../raw.js';
import { QueryBuilder } from '../base.js';
import { TableQueryBuilder, CloneTableQueryBuilder, AlterTableQueryBuilder, DropTableQueryBuilder, TableExistsQueryBuilder } from './table.js';
import { CreateViewQueryBuilder, DropViewQueryBuilder } from './view.js';
import { CreateDatabaseQueryBuilder, DropDatabaseQueryBuilder } from './database.js';
import { EventQueryBuilder, DropEventQueryBuilder } from './event.js';

@NewInstance()
@Inject(Container)
export class SchemaQueryBuilder {
  constructor(protected container: Container, protected driver: OrmDriver) { }

  public createTable(name: string, callback: (table: TableQueryBuilder) => void) {
    const builder = new TableQueryBuilder(this.container, this.driver, name);
    callback.call(this, builder);

    return builder;
  }

  public cloneTable(callback: (clone: CloneTableQueryBuilder) => void) {
    const builder = new CloneTableQueryBuilder(this.container, this.driver);
    callback(builder);
    return builder;
  }

  public alterTable(name: string, callback: (table: AlterTableQueryBuilder) => void) {
    const builder = new AlterTableQueryBuilder(this.container, this.driver, name);
    callback.call(this, builder);
    return builder;
  }

  public dropTable(name: string, schema?: string) {
    return new DropTableQueryBuilder(this.container, this.driver, name, schema);
  }

  public createView(name: string, callback: (view: CreateViewQueryBuilder) => void) {
    const builder = new CreateViewQueryBuilder(this.container, this.driver, name);
    callback.call(this, builder);

    return builder;
  }

  public dropView(name: string, schema?: string) {
    return new DropViewQueryBuilder(this.container, this.driver, name, schema);
  }

  /**
   * Creates database eg.
   *
   * CREATE DATABASE IF NOT EXISTS `db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
   *
   * @param name - database name
   * @param callback - optional callback, options can also be set fluently on returned builder
   */
  public createDatabase(name: string, callback?: (database: CreateDatabaseQueryBuilder) => void) {
    const builder = new CreateDatabaseQueryBuilder(this.container, this.driver, name);

    if (callback) {
      callback.call(this, builder);
    }

    return builder;
  }

  /**
   * Drops whole database with all its content.
   *
   * @param name - database name
   */
  public dropDatabase(name: string) {
    return new DropDatabaseQueryBuilder(this.container, this.driver, name);
  }

  public async tableExists(name: string, schema?: string) {
    const query = new TableExistsQueryBuilder(this.container, this.driver, name);

    if (schema) {
      query.database(schema);
    }

    const exists = await query;
    return exists !== null && exists.length === 1;
  }

  public createEvent(name: string, callback: (event: EventQueryBuilder) => void) {
    const builder = new EventQueryBuilder(this.container, this.driver, name);
    callback.call(this, builder);

    return builder;
  }

  public dropEvent(name: string) {
    return new DropEventQueryBuilder(this.container, this.driver, name);
  }

  /**
   * Executes raw SQL statement on the database.
   * Use this for custom DDL operations or database-specific commands.
   *
   * @param query - raw query string or RawQuery instance
   * @param bindings - optional binding parameters
   */
  public raw(query: string | RawQuery, bindings?: any[]) {
    if (query instanceof RawQuery) {
      return new RawSchemaQueryBuilder(this.container, this.driver, query.Query, query.Bindings);
    }
    return new RawSchemaQueryBuilder(this.container, this.driver, query, bindings);
  }
}

/**
 * Query builder for executing raw SQL statements within schema context.
 * Useful for custom DDL operations, database-specific commands, or
 * any SQL that doesn't fit into the standard schema methods.
 */
@NewInstance()
@Inject(Container)
export class RawSchemaQueryBuilder extends QueryBuilder {
  public Query: string;
  public Bindings: any[];

  constructor(protected container: Container, protected driver: OrmDriver, query: string, bindings?: any[]) {
    super(container, driver);
    this.Query = query;
    this.Bindings = bindings || [];
  }

  protected schemaTouches(): SchemaTouch {
    return 'all';
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<RawSchemaQueryCompiler>(RawSchemaQueryCompiler, [this]).compile();
  }
}
