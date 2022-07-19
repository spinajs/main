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
    return {
      bindings: [this.builder.Database, this.builder.Table],
      expression: `SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ? LIMIT 1;`,
    };
  }
}
