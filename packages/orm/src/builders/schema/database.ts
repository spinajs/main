import { Container, NewInstance } from '@spinajs/di';
import { QueryContext, CreateDatabaseCompiler, DropDatabaseCompiler } from '../../interfaces.js';
import type { ICompilerOutput } from '../../interfaces.js';
import type { OrmDriver } from '../../driver.js';
import type { SchemaTouch } from '../../schema-touches.js';
import { QueryBuilder } from '../base.js';

/**
 * Creates a whole database ( schema in some engines ), eg.
 *
 * CREATE DATABASE IF NOT EXISTS `db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
 *
 * Not every engine supports this - sqlite has no notion of a server side database,
 * and its driver rejects the statement instead of emitting SQL it cannot run.
 */
@NewInstance()
export class CreateDatabaseQueryBuilder extends QueryBuilder {
  /**
   * Name of the database to create. Kept apart from `Database` of the base builder,
   * which qualifies a table with the database it lives in - here the database IS the subject.
   */
  public Name: string;

  public Exists: boolean;

  public Charset: string;

  public Collation: string;

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver, undefined);

    this.Name = name;
    this.Exists = false;
    this.Charset = '';
    this.Collation = '';

    this.QueryContext = QueryContext.Schema;
  }

  /**
   * Adds IF NOT EXISTS clause, so creating an already existing database is not an error.
   */
  public ifNotExists() {
    this.Exists = true;
    return this;
  }

  /**
   * Default character set of the database eg. utf8mb4
   */
  public charset(charset: string) {
    this.Charset = charset;
    return this;
  }

  /**
   * Default collation of the database eg. utf8mb4_unicode_ci
   */
  public collation(collation: string) {
    this.Collation = collation;
    return this;
  }

  protected schemaTouches(): SchemaTouch {
    return [];
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<CreateDatabaseCompiler>(CreateDatabaseCompiler, [this]).compile();
  }
}

@NewInstance()
export class DropDatabaseQueryBuilder extends QueryBuilder {
  public Name: string;

  public Exists: boolean;

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver, undefined);

    this.Name = name;
    this.Exists = false;

    this.QueryContext = QueryContext.Schema;
  }

  /**
   * Adds IF EXISTS clause, so dropping a missing database is not an error.
   */
  public ifExists() {
    this.Exists = true;
    return this;
  }

  protected schemaTouches(): SchemaTouch {
    return 'all';
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<DropDatabaseCompiler>(DropDatabaseCompiler, [this]).compile();
  }
}
