import { SqlDefaultValueBuilder } from './builders.js';
import { SqlTableAliasCompiler, SqlTruncateTableQueryCompiler, SqlLimitQueryCompiler, SqlSelectQueryCompiler, SqlUpdateQueryCompiler, SqlDeleteQueryCompiler, SqlInsertQueryCompiler, SqlTableQueryCompiler, SqlOrderByQueryCompiler, SqlOnDuplicateQueryCompiler, SqlIndexQueryCompiler, SqlWithRecursiveCompiler, SqlForeignKeyQueryCompiler, SqlColumnQueryCompiler, SqlGroupByCompiler, SqlTableCloneQueryCompiler, SqlAlterColumnQueryCompiler, SqlAlterTableQueryCompiler, SqlDropTableQueryCompiler, SqlDropEventQueryCompiler, SqlEventQueryCompiler, SqlTableHistoryQueryCompiler } from './compilers.js';
/* eslint-disable prettier/prettier */
import { SqlDatetimeValueConverter, SqlSetConverter } from './converters.js';
import { ColumnQueryCompiler, TableCloneQueryCompiler, SetValueConverter, GroupByStatement, DateTimeWrapper, DateWrapper, OrmDriver, InStatement, RawQueryStatement, BetweenStatement, WhereStatement, ColumnStatement, ColumnMethodStatement, ExistsQueryStatement, ColumnRawStatement, WhereQueryStatement, SelectQueryCompiler, UpdateQueryCompiler, DeleteQueryCompiler, InsertQueryCompiler, TableQueryCompiler, OrderByQueryCompiler, OnDuplicateQueryCompiler, JoinStatement, IndexQueryCompiler, WithRecursiveStatement, RecursiveQueryCompiler, ForeignKeyQueryCompiler, GroupByQueryCompiler, AlterColumnQueryCompiler, AlterTableQueryCompiler, LimitQueryCompiler, TableAliasCompiler, TruncateTableQueryCompiler, DatetimeValueConverter, DropTableCompiler, DefaultValueBuilder, DropEventQueryCompiler, EventQueryCompiler, TableHistoryQueryCompiler } from '@spinajs/orm';
import { SqlInStatement, SqlRawStatement, SqlBetweenStatement, SqlWhereStatement, SqlColumnStatement, SqlColumnMethodStatement, SqlExistsQueryStatement, SqlColumnRawStatement, SqlWhereQueryStatement, SqlJoinStatement, SqlWithRecursiveStatement, SqlGroupByStatement, SqlDateTimeWrapper, SqlDateWrapper } from './statements.js';

export * from './compilers.js';
export * from './statements.js';

export abstract class SqlDriver extends OrmDriver {
  public resolve() {
    super.resolve();

    this.Container.register(SqlInStatement).as(InStatement);
    this.Container.register(SqlRawStatement).as(RawQueryStatement);
    this.Container.register(SqlBetweenStatement).as(BetweenStatement);
    this.Container.register(SqlWhereStatement).as(WhereStatement);
    this.Container.register(SqlColumnStatement).as(ColumnStatement);
    this.Container.register(SqlJoinStatement).as(JoinStatement);
    this.Container.register(SqlColumnMethodStatement).as(ColumnMethodStatement);
    this.Container.register(SqlExistsQueryStatement).as(ExistsQueryStatement);
    this.Container.register(SqlColumnRawStatement).as(ColumnRawStatement);
    this.Container.register(SqlWhereQueryStatement).as(WhereQueryStatement);
    this.Container.register(SqlWithRecursiveStatement).as(WithRecursiveStatement);
    this.Container.register(SqlGroupByStatement).as(GroupByStatement);
    this.Container.register(SqlDateTimeWrapper).as(DateTimeWrapper);
    this.Container.register(SqlDateWrapper).as(DateWrapper);

    this.Container.register(SqlWithRecursiveCompiler).as(RecursiveQueryCompiler);
    this.Container.register(SqlSelectQueryCompiler).as(SelectQueryCompiler);
    this.Container.register(SqlUpdateQueryCompiler).as(UpdateQueryCompiler);
    this.Container.register(SqlDeleteQueryCompiler).as(DeleteQueryCompiler);
    this.Container.register(SqlInsertQueryCompiler).as(InsertQueryCompiler);
    this.Container.register(SqlDropTableQueryCompiler).as(DropTableCompiler);
    this.Container.register(SqlTruncateTableQueryCompiler).as(TruncateTableQueryCompiler);
    this.Container.register(SqlTableQueryCompiler).as(TableQueryCompiler);
    this.Container.register(SqlOrderByQueryCompiler).as(OrderByQueryCompiler);
    this.Container.register(SqlOnDuplicateQueryCompiler).as(OnDuplicateQueryCompiler);
    this.Container.register(SqlIndexQueryCompiler).as(IndexQueryCompiler);
    this.Container.register(SqlForeignKeyQueryCompiler).as(ForeignKeyQueryCompiler);
    this.Container.register(SqlColumnQueryCompiler).as(ColumnQueryCompiler);
    this.Container.register(SqlGroupByCompiler).as(GroupByQueryCompiler);
    this.Container.register(SqlTableCloneQueryCompiler).as(TableCloneQueryCompiler);
    this.Container.register(SqlAlterColumnQueryCompiler).as(AlterColumnQueryCompiler);
    this.Container.register(SqlAlterTableQueryCompiler).as(AlterTableQueryCompiler);
    this.Container.register(SqlSetConverter).as(SetValueConverter);
    this.Container.register(SqlLimitQueryCompiler).as(LimitQueryCompiler);
    this.Container.register(SqlTableAliasCompiler).as(TableAliasCompiler);
    this.Container.register(SqlDatetimeValueConverter).as(DatetimeValueConverter);
    this.Container.register(SqlDefaultValueBuilder).as(DefaultValueBuilder);

    this.Container.register(SqlDropEventQueryCompiler).as(DropEventQueryCompiler);
    this.Container.register(SqlEventQueryCompiler).as(EventQueryCompiler);
    this.Container.register(SqlTableHistoryQueryCompiler).as(TableHistoryQueryCompiler);
  }
}
