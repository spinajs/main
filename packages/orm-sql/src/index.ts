import { SqlTableAliasCompiler, SqlSelectQueryCompiler, SqlUpdateQueryCompiler, SqlDeleteQueryCompiler, SqlInsertQueryCompiler, SqlTableQueryCompiler, SqlOrderByQueryCompiler, SqlIndexQueryCompiler, SqlForeignKeyQueryCompiler, SqlGroupByCompiler, SqlDropTableQueryCompiler, SqlRawSchemaQueryCompiler, SqlDropViewQueryCompiler, SqlCreateDatabaseQueryCompiler, SqlDropDatabaseQueryCompiler } from './compilers.js';
/* eslint-disable prettier/prettier */
import { SqlDatetimeValueConverter, SqlSetConverter, SqlBooleanValueConverter, SqlTimeValueConverter } from './converters.js';
import { SetValueConverter, GroupByStatement, DateTimeWrapper, DateWrapper, OrmDriver, InStatement, InQueryStatement, RawQueryStatement, BetweenStatement, WhereStatement, ColumnStatement, ColumnMethodStatement, ExistsQueryStatement, ColumnRawStatement, WhereQueryStatement, SelectQueryCompiler, UpdateQueryCompiler, DeleteQueryCompiler, InsertQueryCompiler, TableQueryCompiler, OrderByQueryCompiler, JoinStatement, IndexQueryCompiler, WithRecursiveStatement, ForeignKeyQueryCompiler, GroupByQueryCompiler, TableAliasCompiler, DatetimeValueConverter, DropTableCompiler, QueryContext, Builder, BooleanValueConverter, LazyQueryStatement, TimeValueConverter, InSetStatement, RawSchemaQueryCompiler, DropViewCompiler, CreateDatabaseCompiler, DropDatabaseCompiler } from '@spinajs/orm';
import { SqlInStatement, SqlRawStatement, SqlBetweenStatement, SqlWhereStatement, SqlColumnStatement, SqlColumnMethodStatement, SqlExistsQueryStatement, SqlInQueryStatement, SqlColumnRawStatement, SqlWhereQueryStatement, SqlJoinStatement, SqlWithRecursiveStatement, SqlGroupByStatement, SqlDateTimeWrapper, SqlDateWrapper, SqlLazyQueryStatement, SqlInSetStatement } from './statements.js';
import { Perf } from '@spinajs/log-common';

export * from './compilers.js';
export * from './builders.js';
export * from './statements.js';

export abstract class SqlDriver extends OrmDriver {
  public abstract executeOnDb(stmt: string | object, params: any[], context: QueryContext): Promise<any[] | any>;

  /**
   * Writes the statement to this connection's OWN log source (`orm-driver-<name>`),
   * which is what a query log is routed by - independent of `Perf`, which exists to
   * measure timings and shares its `perf` logger with email and template spans.
   * Enable per connection with a rule, eg:
   *
   *   { name: 'orm-driver-*', level: 'trace', target: 'Console' }
   *
   * Bindings go to the structured fields rather than the message: they routinely
   * hold passwords and personal data, and the message is what lands in plaintext
   * console output.
   */
  protected logQuery(expression: string, bindings: unknown[], builder: Builder<any>) {
    // `Log` is only assigned in OrmDriver.resolve(), so a driver used before it is
    // resolved has none. Logging must never be the thing that breaks a query.
    this.Log?.trace({ sql: expression, bindings, context: String(builder.QueryContext), model: builder.Model?.name }, expression);
  }

  public execute(builder: Builder<any>) {
    try {
      const compiled = builder.toDB();
      const labels = { driver: String(this.Options.Driver ?? 'unknown'), context: String(builder.QueryContext) };

      if (Array.isArray(compiled)) {
        // TODO: rethink this cast
        return Promise.all(
          compiled.map((c) => {
            this.logQuery(c.expression!, c.bindings!, builder);

            return Perf.measure('orm.query', () => this.executeOnDb(c.expression!, c.bindings!, builder.QueryContext), {
              labels,
              fields: { sql: c.expression, bindings: c.bindings },
            });
          }),
        ) as any;
      } else {
        this.logQuery(compiled.expression!, compiled.bindings!, builder);

        return Perf.measure('orm.query', () => this.executeOnDb(compiled.expression!, compiled.bindings!, builder.QueryContext), {
          labels,
          fields: { sql: compiled.expression, bindings: compiled.bindings },
        });
      }
    } catch (err: any) {
      this.Log.error(`Error during query execution: ${err.message}, ${err.stack}, model: ${builder.Model?.name}, context: ${builder.QueryContext}`);
      throw err;
    }
  }

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
    this.Container.register(SqlInQueryStatement).as(InQueryStatement);
    this.Container.register(SqlColumnRawStatement).as(ColumnRawStatement);
    this.Container.register(SqlWhereQueryStatement).as(WhereQueryStatement);
    this.Container.register(SqlWithRecursiveStatement).as(WithRecursiveStatement);
    this.Container.register(SqlGroupByStatement).as(GroupByStatement);
    this.Container.register(SqlDateTimeWrapper).as(DateTimeWrapper);
    this.Container.register(SqlDateWrapper).as(DateWrapper);
    this.Container.register(SqlLazyQueryStatement).as(LazyQueryStatement);

    this.Container.register(SqlSelectQueryCompiler).as(SelectQueryCompiler);
    this.Container.register(SqlUpdateQueryCompiler).as(UpdateQueryCompiler);
    this.Container.register(SqlDeleteQueryCompiler).as(DeleteQueryCompiler);
    this.Container.register(SqlInsertQueryCompiler).as(InsertQueryCompiler);
    this.Container.register(SqlDropTableQueryCompiler).as(DropTableCompiler);
    this.Container.register(SqlTableQueryCompiler).as(TableQueryCompiler);
    this.Container.register(SqlOrderByQueryCompiler).as(OrderByQueryCompiler);
    this.Container.register(SqlIndexQueryCompiler).as(IndexQueryCompiler);
    this.Container.register(SqlForeignKeyQueryCompiler).as(ForeignKeyQueryCompiler);
    this.Container.register(SqlGroupByCompiler).as(GroupByQueryCompiler);
    this.Container.register(SqlSetConverter).as(SetValueConverter);
    this.Container.register(SqlTableAliasCompiler).as(TableAliasCompiler);
    this.Container.register(SqlDatetimeValueConverter).as(DatetimeValueConverter);
    this.Container.register(SqlTimeValueConverter).as(TimeValueConverter);
    this.Container.register(SqlBooleanValueConverter).as(BooleanValueConverter);
    this.Container.register(SqlInSetStatement).as(InSetStatement);


    this.Container.register(SqlRawSchemaQueryCompiler).as(RawSchemaQueryCompiler);

    this.Container.register(SqlDropViewQueryCompiler).as(DropViewCompiler);

    this.Container.register(SqlCreateDatabaseQueryCompiler).as(CreateDatabaseCompiler);
    this.Container.register(SqlDropDatabaseQueryCompiler).as(DropDatabaseCompiler);
  }
}
