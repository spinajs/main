/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable prettier/prettier */

import { SqlDropEventQueryCompiler, SqlDropTableQueryCompiler, SqlEventQueryCompiler, SqlTableHistoryQueryCompiler, SqlOnDuplicateQueryCompiler, SqlIndexQueryCompiler, SqlWithRecursiveCompiler, SqlForeignKeyQueryCompiler, SqlGroupByCompiler, SqlSelectQueryCompiler, SqlUpdateQueryCompiler, SqlDeleteQueryCompiler, SqlInsertQueryCompiler, SqlTableQueryCompiler, SqlColumnQueryCompiler, SqlOrderByQueryCompiler, SqlAlterColumnQueryCompiler, SqlTableCloneQueryCompiler, SqlAlterTableQueryCompiler, SqlLimitQueryCompiler, SqlTableAliasCompiler, SqlTruncateTableQueryCompiler, SqlRawSchemaQueryCompiler, SqlCreateDatabaseQueryCompiler, SqlDropDatabaseQueryCompiler } from './../src/compilers.js';
import { OrmDriver, IColumnDescriptor, InStatement, RawQueryStatement, BetweenStatement, WhereStatement, ColumnStatement, ColumnMethodStatement, ExistsQueryStatement, ColumnRawStatement, WhereQueryStatement, SelectQueryCompiler, UpdateQueryCompiler, DeleteQueryCompiler, InsertQueryCompiler, TableQueryCompiler, ColumnQueryCompiler, OrderByQueryCompiler, OnDuplicateQueryCompiler, JoinStatement, IndexQueryCompiler, RecursiveQueryCompiler, WithRecursiveStatement, ForeignKeyQueryCompiler, GroupByStatement, GroupByQueryCompiler, DateTimeWrapper, DateWrapper, ITransactionContext, ITransactionOptions, AlterColumnQueryCompiler, TableCloneQueryCompiler, AlterTableQueryCompiler, LimitQueryCompiler, TableAliasCompiler, TruncateTableQueryCompiler, DatetimeValueConverter, DropTableCompiler, DefaultValueBuilder, DropEventQueryCompiler, EventQueryCompiler, TableHistoryQueryCompiler, TimeValueConverter, RawSchemaQueryCompiler, ServerResponseMapper, IdentifierQuoter, InSetStatement, CreateDatabaseCompiler, DropDatabaseCompiler } from '@spinajs/orm';
import { SqlInSetStatement, SqlInStatement, SqlRawStatement, SqlBetweenStatement, SqlWhereStatement, SqlColumnStatement, SqlColumnMethodStatement, SqlExistsQueryStatement, SqlColumnRawStatement, SqlWhereQueryStatement, SqlJoinStatement, SqlWithRecursiveStatement, SqlGroupByStatement, SqlDateTimeWrapper, SqlDateWrapper } from '../src/statements.js';
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';
import { join, normalize, resolve } from 'path';
import { SqlDatetimeValueConverter, SqlTimeValueConverter } from '../src/converters.js';
import { SqlDefaultValueBuilder } from './../src/builders.js';
import { BacktickIdentifierQuoter, SqlDriver } from '../src/index.js';

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Minimal stand-in for a driver's insert-response mapper: the plain
 * `{ RowsAffected, LastInsertId }` packet every SQL driver's non-RETURNING path produces.
 */
export class FakeServerResponseMapper extends ServerResponseMapper {
  public read(data: any) {
    return {
      RowsAffected: data?.RowsAffected ?? 0,
      LastInsertId: data?.LastInsertId ?? 0,
      Returning: Array.isArray(data?.Returning) ? data.Returning : [],
    };
  }
}

export class FakeSqliteDriver extends SqlDriver {
  public supportedFeatures() {
    return {
      transactions: true,
      migrations: true,
      tableAlterColumn: true,
      columnComments: true,
      jsonColumn: true,
      upsert: true,
      events: false,
      insertReturning: false,
    };
  }

  protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
    return { depth: 0 };
  }

  protected async _commit(_ctx: ITransactionContext): Promise<void> {
    // no-op, this fake never talks to a database
  }

  protected async _rollback(_ctx: ITransactionContext): Promise<void> {
    // no-op, this fake never talks to a database
  }

  protected async _savepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    // no-op, this fake never talks to a database
  }

  protected async _releaseSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    // no-op, this fake never talks to a database
  }

  protected async _rollbackToSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    // no-op, this fake never talks to a database
  }

  protected async _dispose(_ctx: ITransactionContext): Promise<void> {
    // no-op, this fake never acquires anything
  }

  public async executeOnDb(_stmt: string | object, _params?: any[]): Promise<any[] | any> {
    return true;
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  // tslint:disable-next-line: no-empty
  public async connect(): Promise<OrmDriver> {
    return this;
  }

  // tslint:disable-next-line: no-empty
  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public tableInfo(_table: string, _schema: string): Promise<IColumnDescriptor[]> {
    return null as any;
  }

  public resolve() {
    super.resolve();

    this.Container.register(SqlInStatement).as(InStatement);
    this.Container.register(SqlRawStatement).as(RawQueryStatement);
    this.Container.register(SqlBetweenStatement).as(BetweenStatement);
    this.Container.register(SqlWhereStatement).as(WhereStatement);
    this.Container.register(SqlJoinStatement).as(JoinStatement);
    this.Container.register(SqlColumnStatement).as(ColumnStatement);
    this.Container.register(SqlColumnMethodStatement).as(ColumnMethodStatement);
    this.Container.register(SqlExistsQueryStatement).as(ExistsQueryStatement);
    this.Container.register(SqlColumnRawStatement).as(ColumnRawStatement);
    this.Container.register(SqlWhereQueryStatement).as(WhereQueryStatement);
    this.Container.register(SqlWithRecursiveStatement).as(WithRecursiveStatement);

    // Every real driver registers a response mapper; the fake one never did, so an insert
    // resolved the unimplemented base and blew up inside the result middleware.
    this.Container.register(FakeServerResponseMapper).as(ServerResponseMapper);
    this.Container.register(SqlGroupByStatement).as(GroupByStatement);
    this.Container.register(SqlDateTimeWrapper).as(DateTimeWrapper);
    this.Container.register(SqlDateWrapper).as(DateWrapper);
    this.Container.register(SqlDefaultValueBuilder).as(DefaultValueBuilder);

    this.Container.register(SqlWithRecursiveCompiler).as(RecursiveQueryCompiler);
    this.Container.register(SqlSelectQueryCompiler).as(SelectQueryCompiler);
    this.Container.register(SqlUpdateQueryCompiler).as(UpdateQueryCompiler);
    this.Container.register(SqlDeleteQueryCompiler).as(DeleteQueryCompiler);
    this.Container.register(SqlInsertQueryCompiler).as(InsertQueryCompiler);
    this.Container.register(SqlTableQueryCompiler).as(TableQueryCompiler);
    this.Container.register(SqlColumnQueryCompiler).as(ColumnQueryCompiler);
    this.Container.register(SqlDropTableQueryCompiler).as(DropTableCompiler);
    this.Container.register(SqlOrderByQueryCompiler).as(OrderByQueryCompiler);
    this.Container.register(SqlOnDuplicateQueryCompiler).as(OnDuplicateQueryCompiler);
    this.Container.register(SqlIndexQueryCompiler).as(IndexQueryCompiler);
    this.Container.register(SqlForeignKeyQueryCompiler).as(ForeignKeyQueryCompiler);
    this.Container.register(SqlGroupByCompiler).as(GroupByQueryCompiler);
    this.Container.register(SqlTableCloneQueryCompiler).as(TableCloneQueryCompiler);
    this.Container.register(SqlAlterTableQueryCompiler).as(AlterTableQueryCompiler);
    this.Container.register(SqlAlterColumnQueryCompiler).as(AlterColumnQueryCompiler);
    this.Container.register(SqlLimitQueryCompiler).as(LimitQueryCompiler);
    this.Container.register(SqlTableAliasCompiler).as(TableAliasCompiler);
    this.Container.register(SqlDatetimeValueConverter).as(DatetimeValueConverter);
    this.Container.register(SqlTimeValueConverter).as(TimeValueConverter);
    this.Container.register(SqlTruncateTableQueryCompiler).as(TruncateTableQueryCompiler);

    this.Container.register(SqlDropEventQueryCompiler).as(DropEventQueryCompiler);
    this.Container.register(SqlEventQueryCompiler).as(EventQueryCompiler);
    this.Container.register(SqlTableHistoryQueryCompiler).as(TableHistoryQueryCompiler);
    this.Container.register(SqlRawSchemaQueryCompiler).as(RawSchemaQueryCompiler);
    this.Container.register(SqlCreateDatabaseQueryCompiler).as(CreateDatabaseCompiler);
    this.Container.register(SqlDropDatabaseQueryCompiler).as(DropDatabaseCompiler);

    // Registered explicitly, like a real driver: the shared SqlDriver no longer
    // registers anything dialect-specific, and these suites assert MySQL-shaped SQL.
    this.Container.register(BacktickIdentifierQuoter).as(IdentifierQuoter);
    this.Container.register(SqlInSetStatement).as(InSetStatement);
  }
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        db: {
          Connections: [
            {
              Driver: 'sqlite',
              Filename: 'foo.sqlite',
              Name: 'sqlite',
            },
          ],
        },
      },
      mergeArrays,
    );
  }
}
