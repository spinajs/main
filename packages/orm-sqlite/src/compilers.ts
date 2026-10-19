/* eslint-disable security/detect-object-injection */
/* eslint-disable prettier/prettier */

import { SqlColumnQueryCompiler, SqlTableQueryCompiler, SqlOnDuplicateQueryCompiler, SqlInsertQueryCompiler, SqlAlterColumnQueryCompiler, SqlCreateViewQueryCompiler, SqlLimitQueryCompiler, escapeStringLiteral, SqlIndexQueryCompiler } from '@spinajs/orm-sql';
import { ICompilerOutput, OrderByBuilder, OrderByQueryCompiler, RawQuery, OnDuplicateQueryBuilder, ColumnStatement, InsertQueryBuilder, TableExistsCompiler, TableExistsQueryBuilder, OrmException, TableQueryCompiler, TableQueryBuilder, TableAliasCompiler, ColumnAlterationType, CreateDatabaseCompiler, CreateDatabaseQueryBuilder, DropDatabaseCompiler, DropDatabaseQueryBuilder, CreateViewQueryBuilder, IdentifierQuoter } from '@spinajs/orm';
import { InvalidArgument, NotSupported } from '@spinajs/exceptions';
import { NewInstance, Inject, Container, IContainer, Autoinject } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import _ from 'lodash';

@NewInstance()
export class SqliteTruncateTableQueryCompiler extends TableQueryCompiler {
  constructor(protected container: Container, protected builder: TableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    return {
      bindings: [],
      expression: `DELETE FROM ${this.container.resolve(TableAliasCompiler).compile(this.builder)}`,
    };
  }
}

@NewInstance()
export class SqliteOrderByCompiler extends OrderByQueryCompiler {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  protected _builder: OrderByBuilder;

  constructor(builder: OrderByBuilder) {
    super();

    if (!builder) {
      throw new Error('builder cannot be null or undefined');
    }

    this._builder = builder;
  }
  public compile(): ICompilerOutput {
    const sorts = this._builder.getSorts();
    let stmt = '';
    const bindings = [] as unknown[];

    if (sorts.length > 0) {
      stmt = ` ORDER BY ${sorts.map((s) => `${s.tableAlias ? `${this.Quoter.quote(s.tableAlias)}.` : ''}${this.Quoter.quote(s.column)} ${s.order.toLowerCase() === 'asc' ? 'ASC' : 'DESC'}`).join(', ')}`;
    }

    return {
      bindings,
      expression: stmt,
    };
  }
}
@NewInstance()
export class SqliteOnDuplicateQueryCompiler extends SqlOnDuplicateQueryCompiler {

  constructor(builder: OnDuplicateQueryBuilder) {
    super(builder);
  }

  public compile() {
    if (this._builder.getColumn().length === 0) {
      throw new OrmException(`no unique or primary key columns defined in table ${this._builder.getParent().Table}`);
    }

    const updates: Array<string | RawQuery> = this._builder.getColumnsToUpdate() ?? [];

    // `excluded.col` is the row being inserted, so each conflicting row of a multi row upsert
    // gets its own values
    const columns = updates.map((c: string | RawQuery): string => (_.isString(c) ? `${this.Quoter.quote(c)} = excluded.${this.Quoter.quote(c)}` : c.Query));
    const bindings = _.flatMap(updates, (c: string | RawQuery): unknown[] => (_.isString(c) ? [] : c.Bindings ?? []));
    const action = columns.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${columns.join(',')}`;

    const returning = this._builder.getReturning()[0] === '*' ? ['*'] : this._builder.getReturning().map((c: string) => `\`${c}\``);

    return {
      bindings,
      expression: `ON CONFLICT(${this._builder.getColumn().map((c) => this.Quoter.quote(c)).join(',')}) ${action} RETURNING ${returning.join(',')};`,
    };
  }
}

@NewInstance()
export class SqliteTableExistsCompiler implements TableExistsCompiler {
  constructor(protected builder: TableExistsQueryBuilder) {
    if (builder === null) {
      throw new Error('table exists query builder cannot be null');
    }
  }

  public compile(): ICompilerOutput {
    return {
      bindings: [this.builder.Table],
      expression: `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;`,
    };
  }
}

/**
 * SQLite has no server side databases - a database IS the file the connection was opened on,
 * so CREATE / DROP DATABASE has no meaning here. Registered so the statement fails with a
 * clear message instead of inheriting the shared SQL compiler and shipping syntax sqlite
 * would reject anyway.
 */
@NewInstance()
export class SqliteCreateDatabaseQueryCompiler extends CreateDatabaseCompiler {
  constructor(protected builder: CreateDatabaseQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    throw new NotSupported('sqlite does not support CREATE DATABASE, a database is the file the connection is opened on');
  }
}

@NewInstance()
export class SqliteDropDatabaseQueryCompiler extends DropDatabaseCompiler {
  constructor(protected builder: DropDatabaseQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    throw new NotSupported('sqlite does not support DROP DATABASE, delete the database file instead');
  }
}

@NewInstance()
@Inject(Container)
export class SqliteTableQueryCompiler extends SqlTableQueryCompiler {
  public compile(): ICompilerOutput[] {
    // the shared history compiler emits MySQL triggers ( DELIMITER, FIRST / AFTER ) sqlite cannot run
    if (this.builder.TrackHistory) {
      throw new NotSupported(`sqlite driver does not support history tables, cannot track history of ${this.builder.Table}`);
    }

    const pkColumns = this.builder.Columns.filter((c) => c.PrimaryKey);

    // SQLite has no syntax for two inline PRIMARY KEY column constraints - it rejects
    // `table ... has more than one primary key` - and AUTOINCREMENT is only legal on a single
    // INTEGER PRIMARY KEY. Composite keys therefore move to a table-level constraint and
    // cannot include an auto-increment column.
    if (pkColumns.length > 1) {
      const auto = pkColumns.find((c) => c.AutoIncrement);
      if (auto) {
        throw new OrmException(`sqlite cannot auto-increment column ${auto.Name}: it is part of the composite primary key of ${this.builder.Table}`);
      }
      pkColumns.forEach((c) => (c.InlinePrimaryKey = false));
    }

    const _table = this._table();
    const _columns = this._columns();
    const _foreignKeys = this._foreignKeys();
    const _primaryKey = pkColumns.length > 1 ? this._primaryKeys() : '';

    // Built by concatenation rather than one template literal so that a table with neither a
    // table-level primary key nor foreign keys emits byte-identically to the pre-composite
    // compiler ( a template with two empty interpolations leaves a double space behind ).
    const _extra = `${_primaryKey ? ',' + _primaryKey : ''}${_foreignKeys ? ',' + _foreignKeys : ''}`;

    return [
      {
        bindings: [],
        expression: `${_table} (${_columns}${_extra} )`,
      },
    ];
  }
}

@NewInstance()
@Inject(Container)
export class SqliteInsertQueryCompiler extends SqlInsertQueryCompiler {
  constructor(container: IContainer, builder: InsertQueryBuilder) {
    super(container, builder);
  }

  public compile() {
    const into = this.into();
    const columns = this.columns();
    const values = this.values();
    const upsort = this.upsort();
    const returning = this.returning();

    return {
      bindings: values.bindings.concat(upsort.bindings),
      expression: `${into} ${columns} ${values.data} ${upsort.expression}${returning}`.trim(),
    };
  }

  /**
   * RETURNING on a plain INSERT. Skipped when an upsert clause is present — the ON CONFLICT
   * compiler emits its own RETURNING and two would be invalid SQL.
   */
  protected returning() {
    if (this._builder.Update || this._builder.Returning.length === 0) {
      return '';
    }

    const cols = this._builder.Returning[0] === '*' ? ['*'] : this._builder.Returning.map((c: string) => `\`${c}\``);
    return ` RETURNING ${cols.join(',')}`;
  }

  protected into() {
    return `INSERT${this._builder.Ignore ? ' OR IGNORE' : ''}${this._builder.Replace ? ' OR REPLACE' : ''} INTO \`${this._builder.Table}\``;
  }

  /**
   * A column no row supplies is left out, so sqlite applies the table default - there is no
   * DEFAULT keyword inside VALUES to ask for it per row.
   */
  protected keptColumnIndices(): number[] {
    return super.keptColumnIndices().filter((i) => this._builder.Values.some((row) => row[i] !== undefined));
  }

  /**
   * A row that leaves out a column other rows set renders NULL only when that is provably what
   * the column default gives ( a nullable column without a default ). Anything else cannot be
   * written in one sqlite VALUES list, so it fails here naming the column.
   */
  protected values() {
    if (this._builder.Values.length === 0) {
      throw new InvalidArgument('values count invalid');
    }

    const kept = this.keptColumnIndices();
    const columns = this._builder.getColumns() as ColumnStatement[];
    const bindings: unknown[] = [];

    const rows = this._builder.Values.map((val) => {
      const toInsert = kept.map((i) => {
        const v: unknown = val[i];
        const descriptor = columns[i].Descriptor;

        if (descriptor) {
          if (!descriptor.Nullable && (v === null || v === undefined) && !descriptor.AutoIncrement) {
            throw new InvalidArgument(`value column ${descriptor.Name} cannot be null`);
          }

          if (descriptor.AutoIncrement && descriptor.PrimaryKey && (v === undefined || v === null)) {
            return this.autoIncrementPlaceholder();
          }
        }

        if (v === undefined) {
          if (descriptor && _.isNil(descriptor.DefaultValue)) {
            return 'NULL';
          }

          throw new InvalidArgument(`insert into ${this._builder.Table}: a row has no value for column ${String(columns[i].Column)} that other rows set, and sqlite has no DEFAULT inside VALUES; pass null or the value explicitly`);
        }

        if (v === null) {
          return 'NULL';
        }

        bindings.push(this.tryConvertValue(v));
        return '?';
      });

      return `(${toInsert.join(',')})`;
    });

    return {
      bindings,
      data: `VALUES ${rows.join(',')}`,
    };
  }
}

/**
 * sqlite rejects the shared compiler's offset-only `LIMIT 18446744073709551615` ( it does not fit
 * a signed 64-bit integer ) with SQLITE_MISMATCH; `LIMIT -1` is its spelling of "no limit".
 */
@NewInstance()
export class SqliteLimitQueryCompiler extends SqlLimitQueryCompiler {
  public compile(): ICompilerOutput {
    const limits = this._builder.getLimits();
    const bindings = [];
    let stmt = '';

    if ((limits.limit ?? 0) > 0) {
      stmt += ` LIMIT ?`;
      bindings.push(limits.limit);
    } else if ((limits.offset ?? 0) > 0) {
      stmt += ` LIMIT -1`;
    }

    if ((limits.offset ?? 0) > 0) {
      stmt += ` OFFSET ?`;
      bindings.push(limits.offset);
    }

    return {
      bindings,
      expression: stmt,
    };
  }
}

@NewInstance()
export class SqliteColumnCompiler extends SqlColumnQueryCompiler {

  public compile(): ICompilerOutput {
    const _stmt: string[] = [];

    _stmt.push(`\`${this.builder.Name}\``);

    switch (this.builder.Type) {
      case 'binary':
      case 'tinyblob':
      case 'mediumblob':
      case 'longblob':
        _stmt.push('BLOB');
        break;
      case 'string':
      case 'text':
      case 'mediumtext':
      case 'tinytext':
      case 'longtext':
      case 'date':
      case 'dateTime':
      case 'time':
      case 'set':
      case 'timestamp':
      case 'enum':
        _stmt.push(`TEXT`);
        break;
      case 'float':
      case 'double':
        _stmt.push(`REAL`);
        break;
      case 'decimal':
        _stmt.push(`DECIMAL`);
        break;
      case 'int':
      case 'tinyint':
      case 'smallint':
      case 'mediumint':
      case 'bigint':
        _stmt.push('INTEGER');
        break;
      case 'boolean':
        _stmt.push(this._booleanDefinition());
        break;
    }

    if (this.builder.Unsigned) {
      _stmt.push('UNSIGNED');
    }
    if (this.builder.Collation) {
      _stmt.push(`COLLATE '${this.builder.Collation}'`);
    }
    if (this.builder.NotNull) {
      _stmt.push('NOT NULL');
    }
    if (this.builder.Default) {
      _stmt.push(this._defaultCompiler());
    }
    if (this.builder.PrimaryKey && this.builder.InlinePrimaryKey) {
      _stmt.push(`PRIMARY KEY`);
    }
    if (this.builder.AutoIncrement) {
      _stmt.push(`AUTOINCREMENT`);
    }
    if (this.builder.Unique) {
      _stmt.push('UNIQUE');
    }

    return {
      bindings: [],
      expression: _stmt.filter((x) => !_.isEmpty(x)).join(' '),
    };
  }

  /**
   * CREATE TABLE renders a boolean as a non-nullable 0/1 domain.
   * Overridable: ADD COLUMN cannot carry an unconditional NOT NULL - see
   * {@link SqliteAddColumnCompiler}.
   */
  protected _booleanDefinition(): string {
    return `BOOLEAN NOT NULL CHECK ( \`${this.builder.Name}\` IN (0, 1))`;
  }

  protected _defaultCompiler() {
    let _stmt = '';

    if (_.isNil(this.builder.Default) || (_.isString(this.builder.Default) && _.isEmpty(this.builder.Default.trim()))) {
      return _stmt;
    }

    if (_.isString(this.builder.Default.Value)) {
      _stmt = `DEFAULT '${escapeStringLiteral(this.builder.Default.Value.trim())}'`;
    } else if (_.isNumber(this.builder.Default.Value)) {
      _stmt = `DEFAULT ${this.builder.Default.Value}`;
    } else if (this.builder.Default.Query instanceof RawQuery) {
      _stmt = `DEFAULT (${this.builder.Default.Query.Query})`;
    }

    return _stmt;
  }
}

/**
 * Column body for `ALTER TABLE ... ADD COLUMN`.
 *
 * sqlite refuses to add a NOT NULL column without a non-null default, so the
 * unconditional NOT NULL that CREATE TABLE bakes into a boolean makes every
 * boolean add fail against a table that already holds rows. The CHECK is kept -
 * it is legal in ADD COLUMN and still enforces the 0/1 domain - and NOT NULL is
 * left to the generic `notNull()` flag, so `.notNull().default().value(0)` still
 * yields a non-nullable column.
 */
@NewInstance()
export class SqliteAddColumnCompiler extends SqliteColumnCompiler {
  protected _booleanDefinition(): string {
    return `BOOLEAN CHECK ( \`${this.builder.Name}\` IN (0, 1))`;
  }
}

export interface SqliteAlterColumnQueryCompiler { }

@NewInstance()
@Inject(Container)
export class SqliteAlterColumnQueryCompiler extends SqlAlterColumnQueryCompiler {
  @Logger('ORM')
  protected Log: Log;

  /**
   * The ADD path needs a body free of CREATE-TABLE-only syntax.
   *
   * Note PRIMARY KEY / UNIQUE are deliberately NOT stripped here: sqlite cannot
   * add such a column at all (it rejects both the mysql and the sqlite spelling),
   * so suppressing the clause would silently produce a column WITHOUT the
   * constraint the caller asked for. Letting sqlite's own error surface is honest.
   */
  protected _columnDefinition(): ICompilerOutput {
    if (this.builder.AlterType === ColumnAlterationType.Add) {
      return this.container.resolve<SqliteAddColumnCompiler>(SqliteAddColumnCompiler, [this.builder]).compile();
    }

    return super._columnDefinition();
  }

  // sqlite has no ALTER COLUMN: SqliteOrmDriver.execute rebuilds the table instead, which no single statement expresses.
  protected _modify(_definition: string): string | null {
    throw new NotSupported(`sqlite cannot compile a MODIFY of column ${this.builder.Name}: run the alterTable() on the connection, which rebuilds the table`);
  }

  protected _add(definition: string): string | null {
    // AFTER is mysql-only; sqlite rejects it
    return `ADD ${definition}`;
  }
}

@NewInstance()
@Inject(Container)
export class SqliteCreateViewCompiler extends SqlCreateViewQueryCompiler {
  protected Engine = 'sqlite';

  constructor(container: Container, builder: CreateViewQueryBuilder) {
    super(container, builder);
  }

  protected _temporary(): string {
    return this.builder.Temporary ? 'TEMP' : '';
  }

  protected _ifNotExists(): string {
    return this.builder.IfNotExists ? 'IF NOT EXISTS' : '';
  }
}

// Index names are schema-wide, so DROP INDEX names no table.
@NewInstance()
export class SqliteIndexQueryCompiler extends SqlIndexQueryCompiler {
  protected _drop(): string {
    return `DROP INDEX ${this.Quoter.quote(this._builder.Name)}`;
  }
}
