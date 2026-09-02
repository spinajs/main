/* eslint-disable security/detect-object-injection */
import { NewInstance, Inject, Container, IContainer, Autoinject } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';
import { ICompilerOutput, RawQuery, OnDuplicateQueryBuilder, InsertQueryBuilder, TableExistsCompiler, TableExistsQueryBuilder, OrmException, LimitQueryCompiler, LimitBuilder, CreateDatabaseCompiler, CreateDatabaseQueryBuilder, IdentifierQuoter, ColumnQueryCompiler, TableAliasCompiler } from '@spinajs/orm';
import { SqlInsertQueryCompiler, SqlColumnQueryCompiler, SqlAlterColumnQueryCompiler, SqlOnDuplicateQueryCompiler, SqlDefaultValueBuilder, escapeStringLiteral, assertCharsetName } from '@spinajs/orm-sql';
import _ from 'lodash';

@NewInstance()
export class PostgresTableExistsCompiler implements TableExistsCompiler {
  constructor(protected builder: TableExistsQueryBuilder) {
    if (builder === null) {
      throw new Error('table exists query builder cannot be null');
    }
  }

  public compile(): ICompilerOutput {
    // `Database` on this builder plays the role a schema plays in postgres: one server
    // database holds many schemas, and a connection cannot ask about another database at
    // all. Unqualified checks go against current_schema() — the head of search_path —
    // which is where an unqualified CREATE TABLE would land the table.
    if (this.builder.Database) {
      return {
        bindings: [this.builder.Table, this.builder.Database],
        expression: `SELECT table_name FROM information_schema.tables WHERE table_name = ? AND table_schema = ? LIMIT 1`,
      };
    }

    return {
      bindings: [this.builder.Table],
      expression: `SELECT table_name FROM information_schema.tables WHERE table_name = ? AND table_schema = current_schema() LIMIT 1`,
    };
  }
}

/**
 * LIMIT / OFFSET the postgres way. The shared compiler emits MySQL's
 * `LIMIT 18446744073709551615` for an offset without a limit — a literal larger than
 * BIGINT, which postgres rejects outright. Postgres accepts a bare OFFSET, so the
 * workaround is simply dropped.
 */
@NewInstance()
export class PostgresLimitQueryCompiler extends LimitQueryCompiler {
  protected _builder: LimitBuilder<unknown>;

  constructor(builder: LimitBuilder<unknown>) {
    super();

    if (!builder) {
      throw new Error('builder cannot be null or undefined');
    }

    this._builder = builder;
  }

  public compile(): ICompilerOutput {
    const limits = this._builder.getLimits();
    const bindings = [];
    let stmt = '';

    if ((limits.limit ?? 0) > 0) {
      stmt += ` LIMIT ?`;
      bindings.push(limits.limit);
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

/**
 * Upsert, spelled `ON CONFLICT (...) DO UPDATE`. MySQL's `ON DUPLICATE KEY UPDATE` and its
 * `VALUES(col)` reference are both rejected by postgres; the row that failed to insert is
 * reachable as `EXCLUDED` instead, which — like VALUES(col) — applies each conflicting
 * row's own values in a multi row upsert and needs no bindings.
 */
@NewInstance()
export class PostgresOnDuplicateQueryCompiler extends SqlOnDuplicateQueryCompiler {
  constructor(builder: OnDuplicateQueryBuilder) {
    super(builder);
  }

  public compile() {
    if (this._builder.getColumn().length === 0) {
      throw new OrmException(`no unique or primary key columns defined in table ${this._builder.getParent().Table}`);
    }

    const conflictTarget = this._builder
      .getColumn()
      .map((c: string) => this.Quoter.quote(c))
      .join(',');

    const columns = this._builder
      .getColumnsToUpdate()
      .map((c: string | RawQuery): string => {
        if (_.isString(c)) {
          return `${this.Quoter.quote(c)} = EXCLUDED.${this.Quoter.quote(c)}`;
        } else {
          return c.Query;
        }
      })
      .join(',');

    const bindings = _.flatMap(this._builder.getColumnsToUpdate(), (c: string | RawQuery): any[] => {
      return _.isString(c) ? [] : c.Bindings ?? [];
    });

    const returning = this._builder.getReturning();
    const returningExpression = returning.length === 0 ? '' : ` RETURNING ${returning[0] === '*' ? '*' : returning.map((c: string) => this.Quoter.quote(c)).join(',')}`;

    return {
      bindings,
      expression: `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${columns}${returningExpression}`,
    };
  }
}

@NewInstance()
@Inject(Container)
export class PostgresInsertQueryCompiler extends SqlInsertQueryCompiler {
  constructor(container: IContainer, builder: InsertQueryBuilder) {
    super(container, builder);
  }

  public compile() {
    const into = this.into();
    const columns = this.columns();
    const values = this.values();
    const upsort = this.upsort();
    const ignore = this.ignore();
    const returning = this.returning();

    return {
      bindings: values.bindings.concat(upsort.bindings),
      expression: `${into} ${columns} ${values.data}${ignore} ${upsort.expression}${returning}`.trim(),
    };
  }

  /**
   * An identity column rejects an explicit NULL — postgres wants the DEFAULT keyword where
   * MySQL and SQLite read NULL as "assign the key".
   */
  protected autoIncrementPlaceholder(): string {
    return 'DEFAULT';
  }

  /**
   * `INSERT IGNORE` is MySQL; the postgres spelling of "silently skip the conflicting row"
   * is `ON CONFLICT DO NOTHING`, which comes AFTER the values. Skipped when an upsert
   * clause is present — the ON CONFLICT compiler emits its own conflict handling and two
   * such clauses are invalid SQL.
   */
  protected ignore(): string {
    return this._builder.Ignore && !this._builder.Update ? ' ON CONFLICT DO NOTHING' : '';
  }

  /**
   * RETURNING on a plain INSERT. Skipped when an upsert clause is present — the ON CONFLICT
   * compiler emits its own RETURNING and two would be invalid SQL.
   */
  protected returning() {
    if (this._builder.Update || this._builder.Returning.length === 0) {
      return '';
    }

    const cols = this._builder.Returning[0] === '*' ? ['*'] : this._builder.Returning.map((c: string) => this.Quoter.quote(c));
    return ` RETURNING ${cols.join(',')}`;
  }

  protected into() {
    // no INSERT IGNORE here — see ignore() above
    return `INSERT INTO ${this._container.resolve(TableAliasCompiler).compile(this._builder)}`;
  }
}

/**
 * Column DDL in the postgres dialect. Differences from the shared (MySQL) compiler, each
 * with the postgres answer:
 *
 * - AUTO_INCREMENT does not exist: an integer-family column renders as
 *   `GENERATED BY DEFAULT AS IDENTITY` ( BY DEFAULT, not ALWAYS, because the ORM's batch
 *   insert path may supply an explicit key for some rows of a batch ).
 * - ENUM and SET are not inline types: both render as TEXT, an enum additionally carrying
 *   a CHECK constraint over its members. SET stays plain TEXT because the shared
 *   SqlSetConverter stores a comma-joined string and the LIKE-based InSet statement reads
 *   it back.
 * - UNSIGNED, CHARACTER SET and inline COMMENT have no postgres spelling and are dropped;
 *   COLLATE is kept ( postgres collations are identifiers, so it is quoted ).
 * - MySQL type names map to their postgres equivalents ( DATETIME → TIMESTAMP,
 *   DOUBLE → DOUBLE PRECISION, BLOB → BYTEA, JSON → JSONB ).
 */
@NewInstance()
export class PostgresColumnQueryCompiler extends SqlColumnQueryCompiler {
  public compile(): ICompilerOutput {
    const _stmt: string[] = [];

    _stmt.push(this.Quoter.quote(this.builder.Name));
    _stmt.push(this.typeExpression());

    if (this.builder.AutoIncrement) {
      if (!['int', 'smallint', 'tinyint', 'mediumint', 'bigint'].includes(this.builder.Type)) {
        throw new OrmException(`postgres cannot auto-increment column ${this.builder.Name}: identity requires an integer type, got ${this.builder.Type}`);
      }
      _stmt.push('GENERATED BY DEFAULT AS IDENTITY');
    }

    if (this.builder.Collation) {
      _stmt.push(`COLLATE ${this.Quoter.quote(this.builder.Collation)}`);
    }
    if (this.builder.NotNull) {
      _stmt.push('NOT NULL');
    }
    if (this.builder.Default) {
      _stmt.push(this._defaultCompiler());
    }
    if (this.builder.Type === 'enum') {
      const members = (this.builder.Args[0] as string[]).map((a) => `'${escapeStringLiteral(a)}'`).join(',');
      _stmt.push(`CHECK (${this.Quoter.quote(this.builder.Name)} IN (${members}))`);
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
   * The `DEFAULT ...` fragment of the column body, or '' when none is set — public because
   * the ALTER COLUMN compiler rebuilds it into `ALTER COLUMN x SET DEFAULT ...`.
   */
  public defaultExpression(): string {
    return this._defaultCompiler();
  }

  /**
   * The bare type, without constraints — public because the ALTER COLUMN compiler needs
   * exactly this piece for `ALTER COLUMN x TYPE t`.
   */
  public typeExpression(): string {
    switch (this.builder.Type) {
      case 'string':
        return `VARCHAR(${this.builder.Args[0] ? this.builder.Args[0] : 255})`;
      case 'text':
      case 'tinytext':
      case 'mediumtext':
      case 'longtext':
      case 'set':
      case 'enum':
        return 'TEXT';
      case 'boolean':
        return 'BOOLEAN';
      case 'float':
        return 'REAL';
      case 'double':
        return 'DOUBLE PRECISION';
      case 'decimal': {
        const precision = this.builder.Args[0] ? this.builder.Args[0] : 8;
        const scale = this.builder.Args[1] ? this.builder.Args[1] : 2;
        return `NUMERIC(${precision},${scale})`;
      }
      case 'tinyint':
      case 'smallint':
        return 'SMALLINT';
      case 'int':
      case 'mediumint':
        return 'INTEGER';
      case 'bigint':
        return 'BIGINT';
      case 'binary':
      case 'tinyblob':
      case 'mediumblob':
      case 'longblob':
        return 'BYTEA';
      case 'bit':
        return 'BIT';
      case 'date':
        return 'DATE';
      case 'time':
        return 'TIME';
      case 'dateTime':
      case 'timestamp':
        return 'TIMESTAMP';
      case 'json':
        return 'JSONB';
      default:
        throw new OrmException(`type ${this.builder.Type} is not supported by the postgres driver`);
    }
  }
}

/**
 * ALTER COLUMN, postgres style.
 *
 * MySQL's MODIFY restates the whole column in one clause; postgres alters each attribute
 * with its own action, and — matching MODIFY's semantics, where any omitted attribute is
 * dropped — an absent NOT NULL / DEFAULT drops the constraint rather than leaving it.
 * The actions are comma-joined, so the parent compiler's `ALTER TABLE t ` prefix yields
 * one valid multi-action statement.
 */
@NewInstance()
@Inject(Container)
export class PostgresAlterColumnQueryCompiler extends SqlAlterColumnQueryCompiler {
  @Logger('ORM')
  protected Log: Log;

  protected _columnDefinition(): ICompilerOutput {
    return this.container.resolve<ColumnQueryCompiler>(ColumnQueryCompiler, [this.builder]).compile();
  }

  protected _add(definition: string): string | null {
    if (this.builder.AfterColumn) {
      // AFTER is MySQL-only; postgres appends columns at the end and offers no placement
      this.Log.warn(`postgres cannot place column '${this.builder.Name}' AFTER '${this.builder.AfterColumn}' - the column is appended at the end of the table`);
    }

    return `ADD COLUMN ${definition}`;
  }

  protected _modify(_definition: string): string | null {
    const column = this.Quoter.quote(this.builder.Name);
    const compiler = this.container.resolve<ColumnQueryCompiler>(ColumnQueryCompiler, [this.builder]) as PostgresColumnQueryCompiler;

    const actions = [`ALTER COLUMN ${column} TYPE ${compiler.typeExpression()}`];

    actions.push(this.builder.NotNull ? `ALTER COLUMN ${column} SET NOT NULL` : `ALTER COLUMN ${column} DROP NOT NULL`);

    const defaultExpression = compiler.defaultExpression();
    actions.push(defaultExpression ? `ALTER COLUMN ${column} SET ${defaultExpression}` : `ALTER COLUMN ${column} DROP DEFAULT`);

    return actions.join(', ');
  }
}

/**
 * Postgres spells database DDL its own way: encoding is `ENCODING`, not CHARACTER SET,
 * and CREATE DATABASE has no IF NOT EXISTS at all — existence has to be checked by the
 * caller, so the flag is refused rather than silently dropped.
 */
@NewInstance()
@Inject(Container)
export class PostgresCreateDatabaseQueryCompiler extends CreateDatabaseCompiler {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  constructor(protected container: Container, protected builder: CreateDatabaseQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    if (this.builder.Exists) {
      throw new NotSupported('postgres does not support CREATE DATABASE IF NOT EXISTS - check pg_database yourself before creating');
    }

    const encoding = this.builder.Charset ? ` ENCODING '${assertCharsetName(this.builder.Charset, 'encoding')}'` : '';
    const collation = this.builder.Collation ? ` LC_COLLATE '${escapeStringLiteral(this.builder.Collation)}'` : '';

    return {
      bindings: [],
      expression: `CREATE DATABASE ${this.Quoter.quote(this.builder.Name)}${encoding}${collation}`,
    };
  }
}

// No PostgresDropDatabaseQueryCompiler: `DROP DATABASE IF EXISTS "x"` is exactly what the
// shared SqlDropDatabaseQueryCompiler emits once this driver's quoter is injected, so the
// driver claims the shared compiler instead of duplicating it.

/**
 * `CURRENT_DATE()` — with the parentheses the shared builder emits — is a syntax error in
 * postgres: both CURRENT_DATE and CURRENT_TIMESTAMP are niladic keywords there.
 */
@NewInstance()
export class PostgresDefaultValueBuilder<T> extends SqlDefaultValueBuilder<T> {
  public date(): T {
    this.Query = RawQuery.create('CURRENT_DATE');
    return this.Owner;
  }
}
