import { NewInstance } from '@spinajs/di';
import { TableExistsCompiler, TableExistsQueryBuilder, ICompilerOutput, ILimitBuilder } from '@spinajs/orm';
import { SqlLimitQueryCompiler } from '@spinajs/orm-sql';

@NewInstance()
export class MsSqlTableExistsCompiler implements TableExistsCompiler {
  constructor(protected builder: TableExistsQueryBuilder) {
    if (builder === null) {
      throw new Error('table exists query builder cannot be null');
    }
  }

  public compile(): ICompilerOutput {
    return {
      bindings: [this.builder.Table, this.builder.Schema],
      expression: `SELECT * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? AND TABLE_SCHEMA=? LIMIT 1;`,
    };
  }
}

@NewInstance()
export class MsSqlLimitCompiler extends SqlLimitQueryCompiler {
  public limit(builder: ILimitBuilder): ICompilerOutput {
    const limits = builder.getLimits();
    const bindings = [];
    let stmt = '';

    if (limits.offset > 0) {
      stmt += ` OFFSET ? ROWS`;
      bindings.push(limits.offset);
    }

    if (limits.limit > 0) {
      stmt += ` FETCH FIRST ? ROWS ONLY`;
      bindings.push(limits.limit);
    } else {
      if (limits.offset > 0) {
        stmt += ` FETCH FIRST 18446744073709551615 ROWS ONLY`;
      }
    }

    return {
      bindings,
      expression: stmt,
    };
  }
}
