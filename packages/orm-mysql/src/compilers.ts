import { Container, Inject, NewInstance } from '@spinajs/di';
import { CreateViewQueryBuilder, TableExistsCompiler, TableExistsQueryBuilder, ICompilerOutput } from '@spinajs/orm';
import { SqlCreateViewQueryCompiler } from '@spinajs/orm-sql';

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
