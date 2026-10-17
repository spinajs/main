import { Autoinject, Container, IContainer, Inject, NewInstance } from '@spinajs/di';
import { MethodNotImplemented, NotSupported } from '@spinajs/exceptions';
import { TableExistsCompiler, TableExistsQueryBuilder, ICompilerOutput, ColumnQueryCompiler, ForeignKeyQueryCompiler, ColumnQueryBuilder, TableAliasCompiler, IQueryBuilder, ColumnStatement, RawQuery, InsertQueryBuilder, OrmException, IdentifierQuoter, CreateDatabaseCompiler, CreateDatabaseQueryBuilder, DropDatabaseCompiler, DropDatabaseQueryBuilder, CreateViewQueryBuilder, IOrderByBuilder } from '@spinajs/orm';
import { SqlColumnQueryCompiler, SqlDeleteQueryCompiler, SqlInsertQueryCompiler, SqlLimitQueryCompiler, SqlOrderByQueryCompiler, SqlTableQueryCompiler, SqlOnDuplicateQueryCompiler, assertCharsetName, SqlCreateViewQueryCompiler, SqlDefaultValueBuilder } from '@spinajs/orm-sql';
import _ from 'lodash';

/**
 * Escapes a T-SQL string literal by doubling embedded single quotes. Used for the dynamic
 * CREATE DATABASE batch, where the statement itself has to travel as a literal.
 */
function escapeTsqlLiteral(value: string): string {
  return String(value).replace(/'/g, "''");
}

@NewInstance()
export class MsSqlOnDuplicateQueryCompiler extends SqlOnDuplicateQueryCompiler {

  public compile() {
    const table = this._builder.getParent().Container.resolve(TableAliasCompiler).compile(this._builder.getParent());
    const unique = this._builder.getColumn();

    if (unique.length === 0) {
      throw new OrmException(`no unique columns defined in table ${this._builder.getParent().Table}`);
    }

    const columns = this._builder
      .getColumnsToUpdate()
      .map((c: string | RawQuery): string => {
        if (_.isString(c)) {
          return `${this.Quoter.quote(c)} = ?`;
        } else {
          return c.Query;
        }
      })
      .join(',');

    const parent = this._builder.getParent() as InsertQueryBuilder;

    const valueMap = parent.getColumns().map((c: ColumnStatement) => c.Column);
    const bindings = this._builder.getColumnsToUpdate().map((c: string | RawQuery): any => {
      if (_.isString(c)) {
        return parent.Values[0][valueMap.indexOf(c)];
      } else {
        return c.Bindings;
      }
    });

    const wBindings = unique.map((c) => {
      return parent.Values[0][valueMap.indexOf(c)];
    });

    // The source is built from the inserted values: selected from the target table it is
    // empty for a new row, and WHEN NOT MATCHED would never fire.
    return {
      bindings: wBindings.concat(bindings),
      expression:
        `MERGE INTO ${table} WITH (HOLDLOCK) AS target ` +
        `USING (SELECT ${unique.map((c) => `? AS ${this.Quoter.quote(c)}`).join(', ')}) AS source ` +
        `ON (${unique.map((c) => `target.${this.Quoter.quote(c)} = source.${this.Quoter.quote(c)}`).join(' AND ')}) ` +
        `WHEN MATCHED THEN UPDATE SET ${columns} ` +
        `WHEN NOT MATCHED THEN `,
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

    if (this._builder.Replace) {
      throw new OrmException(`mssql insert or replace is not supported`);
    }

    const into = this.into();
    const columns = this.columns();
    const values = this.values();

    const iBindings = values.bindings;
    const iExpression = `${into} ${columns} ${values.data}`;
    const dResult = super.upsort();

    return {
      bindings: dResult.bindings!.concat(iBindings),
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

/**
 * SQL Server spells database creation differently enough that none of the shared SQL applies:
 * there is no CHARACTER SET ( collation carries both ), no IF NOT EXISTS, and CREATE DATABASE
 * must be the only statement in its batch - so the guarded form goes through EXEC.
 */
@NewInstance()
export class MsSqlCreateDatabaseQueryCompiler extends CreateDatabaseCompiler {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  constructor(protected builder: CreateDatabaseQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    if (this.builder.Charset) {
      throw new NotSupported('mssql has no CHARACTER SET for a database, use collation() instead');
    }

    const collation = this.builder.Collation ? ` COLLATE ${assertCharsetName(this.builder.Collation, 'collation')}` : '';
    const create = `CREATE DATABASE ${this.Quoter.quote(this.builder.Name)}${collation}`;

    return {
      bindings: [],
      // CREATE DATABASE cannot be nested in an IF, hence the dynamic batch. Both literals
      // are the database name with its single quotes doubled - the T-SQL escaping rule.
      expression: this.builder.Exists ? `IF DB_ID('${escapeTsqlLiteral(this.builder.Name)}') IS NULL EXEC('${escapeTsqlLiteral(create)}')` : create,
    };
  }
}

@NewInstance()
export class MsSqlDropDatabaseQueryCompiler extends DropDatabaseCompiler {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  constructor(protected builder: DropDatabaseQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    const exists = this.builder.Exists ? ' IF EXISTS' : '';

    return {
      bindings: [],
      expression: `DROP DATABASE${exists} ${this.Quoter.quote(this.builder.Name)}`,
    };
  }
}

@NewInstance()
export class MsSqlLimitCompiler extends SqlLimitQueryCompiler {

  public compile(): ICompilerOutput {
    const limits = this._builder.getLimits();
    const limit = limits.limit ?? 0;
    const offset = Math.max(limits.offset ?? 0, 0);
    const bindings = [];
    let stmt = '';

    if (limit > 0 || offset > 0) {
      // T-SQL rejects OFFSET without ORDER BY; the select compiler writes the sort right before this
      const sorts = (this._builder as unknown as Partial<IOrderByBuilder>).getSorts?.() ?? [];
      if (sorts.length === 0) {
        stmt += ` ORDER BY (SELECT NULL)`;
      }

      stmt += ` OFFSET ? ROWS`;
      bindings.push(offset);
    }

    if (limit > 0) {
      stmt += ` FETCH NEXT ? ROWS ONLY`;
      bindings.push(limit);
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
    const sorts = this._builder.getSorts();
    let stmt = '';
    const bindings = [] as unknown[];

    if (sorts.length > 0) {
      stmt = ` ORDER BY ${sorts.map((sort) => `${sort.tableAlias ? `${this.Quoter.quote(sort.tableAlias)}.` : ''}${this.Quoter.quote(sort.column)} ${sort.order.toLowerCase() === 'asc' ? 'ASC' : 'DESC'}`).join(', ')}`;
    }

    return {
      bindings,
      expression: stmt,
    };
  }
}

@NewInstance()
export class MsSqlTableQueryCompiler extends SqlTableQueryCompiler {
  public compile(): ICompilerOutput[] {
    if (this.builder.TrackHistory) {
      throw new MethodNotImplemented('orm-driver-mssql has no table history support');
    }

    const _table = this._table();
    const _columns = this._columns();
    // a unique column already carries an inline UNIQUE from the column compiler
    const _keys = this._foreignKeys();

    return [
      {
        bindings: [],
        expression: `${_table} (${_columns}${_keys ? ',' + _keys : ''})`,
      },
    ];
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
    if (this.builder.Temporary) {
      throw new NotSupported('mssql has no CREATE TEMPORARY TABLE, a temporary table is one whose name starts with #');
    }

    const table = this.container.resolve(TableAliasCompiler).compile(this.builder);
    const create = `CREATE TABLE ${table}`;

    return this.builder.CheckExists ? `IF OBJECT_ID(N'${escapeTsqlLiteral(table)}', N'U') IS NULL ${create}` : create;
  }
}

@NewInstance()
export class MsSqlColumnQueryCompiler extends SqlColumnQueryCompiler {

  constructor(protected builder: ColumnQueryBuilder) {
    super(builder);

    this._statementsMappings.autoincrement = () => `IDENTITY(1,1)`;
    this._statementsMappings.boolean = () => `BIT`;
    this._statementsMappings.json = () => `NVARCHAR(MAX)`;
    // T-SQL has no ENUM / SET; a set is stored delimited, as MsSqlInSetStatement reads it
    this._statementsMappings.enum = () => `NVARCHAR(255)`;
    this._statementsMappings.set = () => `NVARCHAR(255)`;
    // no unsigned integers and no inline column comments; the empty string is dropped from the definition
    this._statementsMappings.unsigned = () => '';
    this._statementsMappings.comment = () => '';
    this._statementsMappings.charset = () => {
      throw new NotSupported('mssql has no CHARACTER SET for a column, use collation() instead');
    };
    this._statementsMappings.collation = (b: ColumnQueryBuilder) => `COLLATE ${assertCharsetName(b.Collation, 'collation')}`;
  }
}

/** T-SQL has no `CURRENT_DATE()`; the shared builder is right about everything else. */
@NewInstance()
export class MsSqlDefaultValueBuilder<T> extends SqlDefaultValueBuilder<T> {
  public date(): T {
    this.Query = RawQuery.create('(CAST(GETDATE() AS DATE))');
    return this.Owner;
  }
}

@NewInstance()
export class MsSqlDeleteQueryCompiler extends SqlDeleteQueryCompiler {
  public compile() {
    const _bindings = [];
    const _from = this.from();
    const _where = this.where(this._builder);
    const _expression = _from + (_where.expression ? ` WHERE ${_where.expression}` : '');

    _bindings.push(...(_where.bindings ?? []));

    return {
      bindings: _bindings,
      expression: _expression.trim(),
    };
  }

  protected from() {
    const lBuilder = this._builder;
    const limits = lBuilder.getLimits();

    return `DELETE ${(limits.limit ?? 0) > 0 ? `TOP (${limits.limit}) ` : ''}FROM ${this._container.resolve(TableAliasCompiler).compile(this._builder)}`;
  }
}

@NewInstance()
export class MsSqlTableAliasCompiler implements TableAliasCompiler {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public compile(builder: IQueryBuilder, tbl?: string) {
    let table = '';

    if (builder.Database) {
      table += `${this.Quoter.quote(builder.Database)}.`;
    }

    if (builder.Driver.Options.Options?.Schema) {
      table += `${this.Quoter.quote(builder.Driver.Options.Options?.Schema)}.`;
    }

    table += this.Quoter.quote(tbl ? tbl : builder.Table);

    if (builder.TableAlias) {
      table += ` as ${this.Quoter.quote(builder.TableAlias)}`;
    }

    return table;
  }
}

@NewInstance()
@Inject(Container)
export class MsSqlCreateViewCompiler extends SqlCreateViewQueryCompiler {
  protected Engine = 'mssql';

  constructor(container: Container, builder: CreateViewQueryBuilder) {
    super(container, builder);
  }

  protected _replace(): string {
    return this.builder.Replace ? 'OR ALTER' : '';
  }

  protected _name(): string {
    if (this.builder.Database) {
      throw new MethodNotImplemented('mssql does not allow a database prefix on CREATE VIEW, connect to that database instead');
    }

    return super._name();
  }

  protected _checkOption(): string {
    const option = this.builder.CheckOption;

    if (!option) {
      return '';
    }

    return option === true ? 'WITH CHECK OPTION' : this.unsupported(`WITH ${option} CHECK OPTION`);
  }
}
