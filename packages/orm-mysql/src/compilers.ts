import { Container, IContainer, Inject, NewInstance } from '@spinajs/di';
import { LockTableQueryCompiler, LockTableQueryBuilder, CreateViewQueryBuilder, TableExistsCompiler, TableExistsQueryBuilder, ICompilerOutput, InsertQueryBuilder, TableAliasCompiler } from '@spinajs/orm';
import { SqlCreateViewQueryCompiler, SqlInsertQueryCompiler } from '@spinajs/orm-sql';

@NewInstance()
export class MySqlTableExistsCompiler implements TableExistsCompiler {
  constructor(protected builder: TableExistsQueryBuilder) {
    if (builder === null) {
      throw new Error('table exists query builder cannot be null');
    }
  }

  public compile(): ICompilerOutput {
    if (this.builder.Database) {
      return {
        bindings: [this.builder.Database, this.builder.Table],
        expression: `SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ? LIMIT 1;`,
      };
    }

    // Unqualified means "this connection's own database", not "anywhere on the server".
    // information_schema.tables spans every database, so without the DATABASE() filter a
    // probe for a common name (orm_migrations) matched a table belonging to some other
    // database and reported it present here - so createTableIfAbsent skipped the CREATE and
    // the table was never made. Postgres's compiler already scopes the same way with
    // current_schema(); this keeps the two drivers meaning one thing by "no argument".
    return {
      bindings: [this.builder.Table],
      expression: `SELECT * FROM information_schema.tables WHERE table_name = ? AND table_schema = DATABASE() LIMIT 1;`,
    };
  }
}

@NewInstance()
@Inject(Container)
export class MySqlCreateViewCompiler extends SqlCreateViewQueryCompiler {
  protected Engine = 'mysql';

  constructor(container: Container, builder: CreateViewQueryBuilder) {
    super(container, builder);
  }

  protected _replace(): string {
    return this.builder.Replace ? 'OR REPLACE' : '';
  }

  protected _prefixOptions(): string {
    const options: string[] = [];

    if (this.builder.Algorithm) {
      options.push(`ALGORITHM=${this.builder.Algorithm}`);
    }

    if (this.builder.Security) {
      options.push(`SQL SECURITY ${this.builder.Security}`);
    }

    return options.join(' ');
  }

  protected _checkOption(): string {
    return this.checkOptionSql();
  }
}

/** MySQL spells an insert-or-replace as its own statement, not as a modifier of INSERT. */
@NewInstance()
@Inject(Container)
export class MySqlInsertQueryCompiler extends SqlInsertQueryCompiler {
  constructor(container: IContainer, builder: InsertQueryBuilder) {
    super(container, builder);
  }

  protected into() {
    const table = this._container.resolve(TableAliasCompiler).compile(this._builder);

    if (this._builder.Replace) {
      return `REPLACE INTO ${table}`;
    }

    return `INSERT${this._builder.Ignore ? ' IGNORE' : ''} INTO ${table}`;
  }
}

/**
 * `LOCK TABLES` would commit the open transaction, so this is a locking read of every row: its next-key
 * locks keep writers out until commit under REPEATABLE READ (the InnoDB default). Exclusive, because
 * InnoDB may count through a secondary index and puts shared locks on that index only, where an update
 * of an unindexed column never looks; exclusive locks also reach the clustered records. Plain reads are
 * not locking reads and go on.
 */
@NewInstance()
@Inject(Container)
export class MySqlLockTableQueryCompiler extends LockTableQueryCompiler {
  constructor(protected container: Container, protected builder: LockTableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput[] {
    return [{ bindings: [], expression: `SELECT COUNT(*) FROM ${this.container.resolve(TableAliasCompiler).compile(this.builder)} FOR UPDATE` }];
  }
}
