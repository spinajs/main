import { Configuration } from '@spinajs/configuration';
import { OrmException } from './../../orm/src/exceptions';
import { Inject, NewInstance } from '@spinajs/di';
import { TableExistsCompiler, TableExistsQueryBuilder, ICompilerOutput, ColumnQueryCompiler, ForeignKeyQueryCompiler, ColumnQueryBuilder, IWhereBuilder, ILimitBuilder, TableAliasCompiler, IQueryBuilder } from '@spinajs/orm';
import { SqlColumnQueryCompiler, SqlDeleteQueryCompiler, SqlInsertQueryCompiler, SqlLimitQueryCompiler, SqlOrderByQueryCompiler, SqlTableQueryCompiler } from '@spinajs/orm-sql';

@NewInstance()
export class MsSqlInsertQueryCompiler extends SqlInsertQueryCompiler {
  public compile() {
    if (this._builder.Ignore) {
      throw new OrmException(`mssql insert or ignore is not supported`);
    }

    const result = super.compile();
    return {
      bindings: result.bindings,
      expression: result.expression + ' SELECT SCOPE_IDENTITY() as ID',
    };
  }
}

@NewInstance()
export class MsSqlTableExistsCompiler implements TableExistsCompiler {
  constructor(protected builder: TableExistsQueryBuilder) {
    if (builder === null) {
      throw new Error('table exists query builder cannot be null');
    }
  }

  public compile(): ICompilerOutput {
    const bindings = [this.builder.Table];
    let expression = '';

    if (this.builder.Database) {
      bindings.push(this.builder.Database);
      expression = `SELECT * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? AND TABLE_CATALOG=? ORDER BY TABLE_NAME OFFSET 0 ROWS FETCH FIRST 1 ROWS ONLY`;
    } else {
      expression = `SELECT * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? ORDER BY TABLE_NAME OFFSET 0 ROWS FETCH FIRST 1 ROWS ONLY`;
    }

    return {
      bindings,
      expression,
    };
  }
}

@NewInstance()
export class MsSqlLimitCompiler extends SqlLimitQueryCompiler {
  public compile(): ICompilerOutput {
    const limits = this._builder.getLimits();
    const bindings = [];
    let stmt = '';

    if (limits.limit > 0) {
      stmt += ` OFFSET ? ROWS`;
      bindings.push(Math.max(limits.offset, 0));
      stmt += ` FETCH NEXT ? ROWS ONLY`;
      bindings.push(limits.limit);
    }

    return {
      bindings,
      expression: stmt,
    };
  }
}

@NewInstance()
export class MsSqlOrderByCompiler extends SqlOrderByQueryCompiler {
  public compile(): ICompilerOutput {
    const sort = this._builder.getSort();
    let stmt = '';
    const bindings = [] as unknown[];

    if (sort) {
      stmt = ` ORDER BY \`${sort.column}\` ${sort.order.toLowerCase() === 'asc' ? 'ASC' : 'DESC'}`;
    }

    return {
      bindings,
      expression: stmt,
    };
  }
}

@NewInstance()
export class MsSqlTableQueryCompiler extends SqlTableQueryCompiler {
  public compile(): ICompilerOutput {
    const _table = this._table();
    const _columns = this._columns();
    const _keys = [this._foreignKeys()];

    return {
      bindings: [],
      expression: `${_table} (${_columns} ${_keys.filter((k) => k && k !== '').join(',')})`,
    };
  }

  protected _columns() {
    return this.builder.Columns.map((c) => {
      const expr = this.container.resolve(ColumnQueryCompiler, [c]).compile().expression;
      if (c.PrimaryKey) {
        return expr + ' PRIMARY KEY';
      }

      return expr;
    }).join(',');
  }

  protected _foreignKeys() {
    return this.builder.ForeignKeys.map((f) => {
      return this.container.resolve(ForeignKeyQueryCompiler, [f]).compile().expression;
    }).join(',');
  }

  protected _table() {
    return `CREATE${this.builder.Temporary ? ' TEMPORARY ' : ' '}TABLE ${this.builder.CheckExists ? 'IF NOT EXISTS ' : ''}${this.container.resolve(TableAliasCompiler).compile(this.builder)}`;
  }
}

@NewInstance()
export class MsSqlColumnQueryCompiler extends SqlColumnQueryCompiler {
  constructor(protected builder: ColumnQueryBuilder) {
    super(builder);

    // MSSQL usess this expression for AUTO_INCREMENT
    this._statementsMappings.autoincrement = () => `IDENTITY(1,1)`;
  }
}

@NewInstance()
export class MsSqlDeleteQueryCompiler extends SqlDeleteQueryCompiler {
  public compile() {
    const _bindings = [];
    const _from = this.from();
    const _where = this.where(this._builder as IWhereBuilder);

    let _expression = '';

    if (this._builder.Truncate) {
      _expression = `TRUNCATE TABLE ${this._container.resolve(TableAliasCompiler).compile(this._builder)}`;
    } else {
      _expression = _from + (_where.expression ? ` WHERE ${_where.expression}` : '');
    }

    _bindings.push(..._where.bindings);

    return {
      bindings: _bindings,
      expression: _expression.trim(),
    };
  }

  protected from() {
    const lBuilder = this._builder as ILimitBuilder;
    const limits = lBuilder.getLimits();

    return `DELETE ${limits.limit > 0 ? `TOP ${limits.limit} ` : ''}FROM ${this._container.resolve(TableAliasCompiler).compile(this._builder)}`;
  }
}

@Inject(Configuration)
export class MsSqlTableAliasCompiler implements TableAliasCompiler {
  public compile(builder: IQueryBuilder, tbl?: string) {
    let table = '';

    if (builder.Database) {
      table += `\`${builder.Database}\`.`;
    }

    if (builder.Driver.Options.Options?.Schema) {
      table += `\`${builder.Driver.Options.Options?.Schema}\`.`;
    }

    table += `\`${tbl ? tbl : builder.Table}\``;

    if (builder.TableAlias) {
      table += ` as \`${builder.TableAlias}\``;
    }

    return table;
  }
}