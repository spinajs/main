import { NewInstance } from '@spinajs/di';
import { TableExistsCompiler, TableExistsQueryBuilder, ICompilerOutput, ColumnQueryCompiler, ForeignKeyQueryCompiler, ColumnQueryBuilder } from '@spinajs/orm';
import { SqlColumnQueryCompiler, SqlLimitQueryCompiler, SqlOrderByQueryCompiler, SqlTableQueryCompiler } from '@spinajs/orm-sql';

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

    if (this.builder.Schema) {
      bindings.push(this.builder.Schema);
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
    return `CREATE${this.builder.Temporary ? ' TEMPORARY ' : ' '}TABLE ${this.builder.CheckExists ? 'IF NOT EXISTS ' : ''}${this.tableAliasCompiler(this.builder)}`;
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
