/* eslint-disable security/detect-object-injection */
/* eslint-disable prettier/prettier */

import { SqlColumnQueryCompiler, SqlTableQueryCompiler, SqlOnDuplicateQueryCompiler, SqlInsertQueryCompiler, SqlAlterColumnQueryCompiler } from '@spinajs/orm-sql';
import { ICompilerOutput, OrderByBuilder, OrderByQueryCompiler, RawQuery, OnDuplicateQueryBuilder, ColumnStatement, InsertQueryBuilder, TableExistsCompiler, TableExistsQueryBuilder, OrmException, TableQueryCompiler, TableQueryBuilder, TableAliasCompiler, ColumnAlterationType } from '@spinajs/orm';
import { NewInstance, Inject, Container, IContainer } from '@spinajs/di';
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
  protected _builder: OrderByBuilder;

  constructor(builder: OrderByBuilder) {
    super();

    if (!builder) {
      throw new Error('builder cannot be null or undefined');
    }

    this._builder = builder;
  }
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
export class SqliteOnDuplicateQueryCompiler extends SqlOnDuplicateQueryCompiler {
  constructor(builder: OnDuplicateQueryBuilder) {
    super(builder);
  }

  public compile() {
    if (this._builder.getColumn().length === 0) {
      throw new OrmException(`no unique or primary key columns defined in table ${this._builder.getParent().Table}`);
    }

    const columns = this._builder.getColumnsToUpdate().map((c: string | RawQuery): string => {
      if (_.isString(c)) {
        return `${c} = ?`;
      } else {
        return c.Query;
      }
    });

    const parent = this._builder.getParent() as InsertQueryBuilder;

    const bindings = _.flatMap(this._builder.getColumnsToUpdate(), (c: string | RawQuery) => {
      if (_.isString(c)) {
        const cIndex = parent.getColumns().findIndex((col: ColumnStatement) => (_.isString(col.Column) ? col.Column === c : null));
        return parent.Values[0][cIndex];
      } else {
        return c.Bindings;
      }
    });

    const returning = this._builder.getReturning()[0] === '*' ? ['*'] : this._builder.getReturning().map((c: string) => `\`${c}\``);

    return {
      bindings,
      expression: `ON CONFLICT(${this._builder.getColumn().join(',')}) DO UPDATE SET ${columns.join(',')} RETURNING ${returning.join(',')};`,
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

@NewInstance()
@Inject(Container)
export class SqliteTableQueryCompiler extends SqlTableQueryCompiler {
  public compile(): ICompilerOutput[] {
    const _table = this._table();
    const _columns = this._columns();
    const _foreignKeys = this._foreignKeys();

    return [
      {
        bindings: [],
        expression: `${_table} (${_columns} ${_foreignKeys ? ',' + _foreignKeys : ''})`,
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

    return {
      bindings: values.bindings.concat(upsort.bindings),
      expression: `${into} ${columns} ${values.data} ${upsort.expression}`.trim(),
    };
  }

  protected into() {
    return `INSERT${this._builder.Ignore ? ' OR IGNORE' : ''}${this._builder.Replace ? ' OR REPLACE' : ''} INTO \`${this._builder.Table}\``;
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
    if (this.builder.Charset) {
      _stmt.push(`CHARACTER SET '${this.builder.Charset}'`);
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
    if (this.builder.Comment) {
      _stmt.push(`COMMENT '${this.builder.Comment}'`);
    }
    if (this.builder.PrimaryKey) {
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
      _stmt = `DEFAULT '${this.builder.Default.Value.trim()}'`;
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

  /**
   * sqlite cannot change a column's type: it has no MODIFY / ALTER COLUMN.
   * It is also dynamically typed and renders enum/string/date as unconstrained
   * TEXT, so a type-only change is a semantic no-op here anyway.
   *
   * Constraint changes (NOT NULL / DEFAULT / UNIQUE) ARE enforced by sqlite and
   * are NOT applied - they need an explicit table-rebuild migration. Warn rather
   * than throw: portable migrations legitimately restate existing constraints
   * (mysql's MODIFY drops any attribute you omit), and throwing would break them.
   */
  protected _modify(_definition: string): string | null {
    this.Log.warn(`sqlite cannot MODIFY column '${this.builder.Name}' - skipping. Type changes are a no-op (sqlite is dynamically typed); any NOT NULL / DEFAULT / UNIQUE change was NOT applied. Write an explicit table-rebuild migration if you need one.`);
    return null;
  }

  protected _add(definition: string): string | null {
    // AFTER is mysql-only; sqlite rejects it
    return `ADD ${definition}`;
  }
}
