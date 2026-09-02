import { NewInstance } from '@spinajs/di';
import { TableExistsCompiler, TableExistsQueryBuilder, ICompilerOutput } from '@spinajs/orm';

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
