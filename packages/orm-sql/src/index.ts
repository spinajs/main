import { SqlTableAliasCompiler, SqlSelectQueryCompiler, SqlUpdateQueryCompiler, SqlDeleteQueryCompiler, SqlInsertQueryCompiler, SqlTableQueryCompiler, SqlOrderByQueryCompiler, SqlIndexQueryCompiler, SqlForeignKeyQueryCompiler, SqlGroupByCompiler, SqlDropTableQueryCompiler, SqlRawSchemaQueryCompiler, SqlDropViewQueryCompiler, SqlCreateDatabaseQueryCompiler, SqlDropDatabaseQueryCompiler } from './compilers.js';
/* eslint-disable prettier/prettier */
import { SqlDatetimeValueConverter, SqlSetConverter, SqlBooleanValueConverter, SqlTimeValueConverter } from './converters.js';
import { SetValueConverter, ColumnCompareStatement, ColumnConditionStatement, GroupByStatement, DateTimeWrapper, DateWrapper, TextWrapper, OrmDriver, InStatement, InQueryStatement, RawQueryStatement, BetweenStatement, WhereStatement, ColumnStatement, ColumnMethodStatement, ExistsQueryStatement, ColumnRawStatement, WhereQueryStatement, SelectQueryCompiler, UpdateQueryCompiler, DeleteQueryCompiler, InsertQueryCompiler, TableQueryCompiler, OrderByQueryCompiler, JoinStatement, IndexQueryCompiler, WithRecursiveStatement, ForeignKeyQueryCompiler, GroupByQueryCompiler, TableAliasCompiler, DatetimeValueConverter, DropTableCompiler, QueryContext, Builder, BooleanValueConverter, LazyQueryStatement, TimeValueConverter, InSetStatement, StartsWithStatement, RawSchemaQueryCompiler, DropViewCompiler, CreateDatabaseCompiler, DropDatabaseCompiler } from '@spinajs/orm';
import { SqlInStatement, SqlRawStatement, SqlBetweenStatement, SqlWhereStatement, SqlColumnStatement, SqlColumnMethodStatement, SqlExistsQueryStatement, SqlInQueryStatement, SqlColumnRawStatement, SqlWhereQueryStatement, SqlColumnCompareStatement, SqlColumnConditionStatement, SqlJoinStatement, SqlWithRecursiveStatement, SqlGroupByStatement, SqlDateTimeWrapper, SqlDateWrapper, SqlTextWrapper, SqlLazyQueryStatement, SqlInSetStatement, SqlStartsWithStatement } from './statements.js';
import { Perf } from '@spinajs/log-common';
import { DateTime } from 'luxon';

export * from './compilers.js';
export * from './builders.js';
export * from './statements.js';
export * from './literals.js';
export * from './views.js';
export * from './converters.js';

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
    // The SQL is a printf arg: as the template its `${...}` would be read as placeholders, as a field it prints quoted.
    this.Log?.trace({ sql: expression, bindings, context: String(builder.QueryContext), model: builder.Model?.name }, '%s', expression);
  }

  /**
   * Raw fragments and direct `executeOnDb` calls bind what they are given; a Date or DateTime among
   * those parameters is written the way the dialect stores a datetime column, so raw SQL compares with
   * model-written values.
   */
  protected toDriverParams(params: unknown[] | undefined): unknown[] {
    const isDate = (p: unknown) => p instanceof Date || DateTime.isDateTime(p);
    if (!params || !params.some(isDate)) {
      return params ?? [];
    }

    const converter = this.Container.resolve<DatetimeValueConverter>(DatetimeValueConverter);
    return params.map((p) => (isDate(p) ? converter.toDB(p, null as any, null as any) : p));
  }

  public execute(builder: Builder<any>) {
    try {
      const compiled = builder.toDB();
      const labels = { driver: String(this.Options.Driver ?? 'unknown'), context: String(builder.QueryContext) };

      if (Array.isArray(compiled)) {
        // Statements must run in order (e.g. CREATE TABLE before dependent INSERT);
        // a pooled driver would otherwise spread them over connections concurrently.
        return (async () => {
          const results: unknown[] = [];
          for (const c of compiled) {
            this.logQuery(c.expression!, c.bindings!, builder);

            results.push(
              await Perf.measure('orm.query', () => this.executeOnDb(c.expression!, c.bindings!, builder.QueryContext), {
                labels,
                fields: { sql: c.expression, bindings: c.bindings },
              }),
            );
          }
          return results;
        })() as any;
      } else {
        this.logQuery(compiled.expression!, compiled.bindings!, builder);

        return Perf.measure('orm.query', () => this.executeOnDb(compiled.expression!, compiled.bindings!, builder.QueryContext), {
          labels,
          fields: { sql: compiled.expression, bindings: compiled.bindings },
        });
      }
    } catch (err: any) {
      this.Log.error({ error: err, model: builder.Model?.name, context: builder.QueryContext }, 'Error during query execution, model: ${model}, context: ${context}');
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
    this.Container.register(SqlColumnConditionStatement).as(ColumnConditionStatement);
    this.Container.register(SqlWhereQueryStatement).as(WhereQueryStatement);
    this.Container.register(SqlColumnCompareStatement).as(ColumnCompareStatement);
    this.Container.register(SqlWithRecursiveStatement).as(WithRecursiveStatement);
    this.Container.register(SqlGroupByStatement).as(GroupByStatement);
    this.Container.register(SqlDateTimeWrapper).as(DateTimeWrapper);
    this.Container.register(SqlDateWrapper).as(DateWrapper);
    this.Container.register(SqlTextWrapper).as(TextWrapper);
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
    this.Container.register(SqlStartsWithStatement).as(StartsWithStatement);


    this.Container.register(SqlRawSchemaQueryCompiler).as(RawSchemaQueryCompiler);

    this.Container.register(SqlDropViewQueryCompiler).as(DropViewCompiler);

    this.Container.register(SqlCreateDatabaseQueryCompiler).as(CreateDatabaseCompiler);
    this.Container.register(SqlDropDatabaseQueryCompiler).as(DropDatabaseCompiler);
  }
}
