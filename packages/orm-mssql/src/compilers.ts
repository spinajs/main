import { Configuration } from '@spinajs/configuration';
import { IContainer, Inject, NewInstance } from '@spinajs/di';
import { TableExistsCompiler, TableExistsQueryBuilder, ICompilerOutput, ColumnQueryCompiler, ForeignKeyQueryCompiler, ColumnQueryBuilder, TableAliasCompiler, IQueryBuilder, OnDuplicateQueryBuilder, ColumnStatement, RawQuery, extractModelDescriptor, InsertQueryBuilder, OrmException } from '@spinajs/orm';
import { SqlColumnQueryCompiler, SqlDeleteQueryCompiler, SqlInsertQueryCompiler, SqlLimitQueryCompiler, SqlOrderByQueryCompiler, SqlTableQueryCompiler, SqlOnDuplicateQueryCompiler } from '@spinajs/orm-sql';
import _ from 'lodash';

@NewInstance()
export class MsSqlOnDuplicateQueryCompiler extends SqlOnDuplicateQueryCompiler {
  protected _builder: OnDuplicateQueryBuilder;

  public compile() {
    const table = this._builder.getParent().Container.resolve(TableAliasCompiler).compile(this._builder.getParent());
    const descriptor = extractModelDescriptor(this._builder.getParent().Model);

    if (this._builder.getColumn().length === 0) {
      throw new OrmException(`no unique columns defined in table ${this._builder.getParent().Table}`);
    }

    const columns = this._builder
      .getColumnsToUpdate()
      .map((c: string | RawQuery): string => {
        if (_.isString(c)) {
          return `\`${c}\` = ?`;
        } else {
          return c.Query;
        }
      })
      .join(',');

    const valueMap = this._builder
      .getParent()
      .getColumns()
      .map((c: ColumnStatement) => c.Column);
    const bindings = this._builder.getColumnsToUpdate().map((c: string | RawQuery): any => {
      if (_.isString(c)) {
        return this._builder.getParent().Values[0][valueMap.indexOf(c)];
      } else {
        return c.Bindings;
      }
    });

    const wBindings = this._builder.getColumn().map((c) => {
      return this._builder.getParent().Values[0][valueMap.indexOf(c)];
    });

    return {
      bindings: wBindings.concat(bindings),
      expression: `MERGE INTO ${table} WITH (HOLDLOCK) AS target
      USING (SELECT * FROM ${table} WHERE ${this._builder.getColumn().map((c) => {
        return `${c} = ?`;
      })}) as source
      ON (target.${descriptor.PrimaryKey} = source.${descriptor.PrimaryKey})
      WHEN MATCHED
        THEN UPDATE
            SET ${columns}
      WHEN NOT MATCHED
        THEN `.replace(/(\r\n|\n|\r)/gm, ''),
    };
  }
}

@NewInstance()
export class MsSqlInsertQueryCompiler extends SqlInsertQueryCompiler {
  protected isDuplicate = false;

  constructor(container: IContainer, builder: InsertQueryBuilder) {
    super(container, builder);

    this.isDuplicate = this._builder.DuplicateQueryBuilder !== null && this._builder.DuplicateQueryBuilder !== undefined;
  }

  public compile() {
    if (this._builder.Ignore) {
      throw new OrmException(`mssql insert or ignore is not supported`);
    }

    const into = this.into();
    const columns = this.columns();
    const values = this.values();

    const iBindings = values.bindings;
    const iExpression = `${into} ${columns} ${values.data}`;
    const dResult = super.upsort();

    return {
      bindings: dResult.bindings.concat(iBindings),
      expression: dResult.expression + iExpression + '; SELECT SCOPE_IDENTITY() as ID;',
    };
  }

  protected into() {
    return `INSERT ${this.isDuplicate ? '' : `INTO ${this._container.resolve(TableAliasCompiler).compile(this._builder)}`} `;
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
      expression = `SELECT TOP(1) * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? AND TABLE_CATALOG=? ORDER BY TABLE_NAME`;
    } else {
      expression = `SELECT TOP(1) * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? ORDER BY TABLE_NAME`;
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
    const _unique = this.builder.Columns.filter((c) => c.Unique).map((c) => c.Name);

    return {
      bindings: [],
      expression: `${_table} (${_columns} ${_unique.length !== 0 ? `, UNIQUE(${_unique.join(',')}) ` : ''} ${_keys ? ',' + _keys.filter((k) => k && k !== '').join(',') : ''})`,
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
    const _where = this.where(this._builder);
    const _expression = _from + (_where.expression ? ` WHERE ${_where.expression}` : '');

    _bindings.push(..._where.bindings);

    return {
      bindings: _bindings,
      expression: _expression.trim(),
    };
  }

  protected from() {
    const lBuilder = this._builder;
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
