import { IQueryStatement, JoinMethod, LazyQueryStatement, QueryBuilder, SelectQueryBuilder, WhereBuilder } from '@spinajs/orm';
/* eslint-disable prettier/prettier */
import { SqlWhereCompiler } from './compilers.js';
import { NewInstance } from '@spinajs/di';
import { ModelBase, SqlOperator, BetweenStatement, JoinStatement, ColumnStatement, ColumnRawStatement, InStatement, IQueryStatementResult, RawQueryStatement, WhereStatement, ExistsQueryStatement, ColumnMethodStatement, WhereQueryStatement, WithRecursiveStatement, GroupByStatement, RawQuery, DateWrapper, DateTimeWrapper, Wrap, WrapStatement, ValueConverter, extractModelDescriptor } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';

function _columnWrap(column: string, tableAlias: string, isAggregate?: boolean): string {
  if (tableAlias && !isAggregate) {
    return `\`${tableAlias}\`.\`${column}\``;
  }

  return `\`${column}\``;
}

@NewInstance()
export class SqlRawStatement extends RawQueryStatement {
  public clone(): SqlRawStatement {
    return new SqlRawStatement(this._query, this._bindings);
  }

  public build(): IQueryStatementResult {
    return {
      Bindings: this._bindings,
      Statements: [`${this._query}`],
    };
  }
}

@NewInstance()
export class SqlLazyQueryStatement extends LazyQueryStatement {

  public clone(): SqlLazyQueryStatement {
    return new SqlLazyQueryStatement(this.callback, this.context);
  }

  build(): IQueryStatementResult {

    const context = (this.context as SelectQueryBuilder).clone();
    context.setAlias((this.context as SelectQueryBuilder).TableAlias);

    context.clearColumns().clearGroupBy().clearJoins().clearWhere();

    this.callback?.call(context);
    const result = context.Statements.map((s) => s.build());

    return {
      Bindings: result.flatMap((x) => x.Bindings),
      Statements: result.flatMap((x) => x.Statements),
    }
  }

}

@NewInstance()
export class SqlWithRecursiveStatement extends WithRecursiveStatement {
  public clone(): SqlWithRecursiveStatement {
    return new SqlWithRecursiveStatement(this.container, this._name, this._query, this._rcKeyName, this._pkName);
  }

  public build(): IQueryStatementResult {
    const initialQuery = this._query.clone().clearJoins().toDB();

    const joinStmt = this.container.resolve(JoinStatement, [this._query, this._query.Model, 'recursive_cte', JoinMethod.RECURSIVE, this._pkName, this._rcKeyName, '$recursive$', '$recursive_cte$']);
    this._query.JoinStatements.push(joinStmt);
    const additionalQuery = this._query.clone().clearWhere().setAlias('$recursive$').toDB();
    const cte_columns = this._query
      .getColumns()
      .map((c: ColumnStatement) => c.Column)
      .join(',');

    return {
      Bindings: initialQuery.bindings.concat(additionalQuery.bindings),
      Statements: [cte_columns, initialQuery.expression, additionalQuery.expression],
    };
  }
}

@NewInstance()
export class SqlBetweenStatement extends BetweenStatement {
  public clone(): SqlBetweenStatement {
    return new SqlBetweenStatement(this._column, this._val, this._not, this._tableAlias);
  }

  public build(): IQueryStatementResult {
    const exprr = this._not ? 'NOT BETWEEN' : 'BETWEEN';

    return {
      Bindings: this._val,
      Statements: [`${_columnWrap(this._column, this._tableAlias)} ${exprr} ? AND ?`],
    };
  }
}

@NewInstance()
export class SqlGroupByStatement extends GroupByStatement {
  public clone(): SqlGroupByStatement {
    return new SqlGroupByStatement(this._expr, this.TableAlias);
  }

  build(): IQueryStatementResult {
    if (this._expr instanceof RawQuery) {
      return {
        Bindings: this._expr.Bindings ?? [],
        Statements: [`${this._expr.Query}`],
      };
    } else {
      return {
        Bindings: [],
        Statements: [`\`${this._expr}\``],
      };
    }
  }
}

@NewInstance()
export class SqlWhereStatement extends WhereStatement {

  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(builder: T): SqlWhereStatement {
    return new SqlWhereStatement(
      this._column,
      this._operator,
      this._value,
      builder as WhereBuilder<any>,
    );
  }

  public build(): IQueryStatementResult {
    const isNullableQuery = this._operator === SqlOperator.NOT_NULL || this._operator === SqlOperator.NULL;
    const binding = isNullableQuery ? '' : ' ?';
    let column = this._column;
    let val = this._value;
    if (this._model) {
      const desc = extractModelDescriptor(this._model);
      const rel = desc.Relations.get(column as string);
      if (rel) {
        column = rel.ForeignKey;
      }
    }

    if (column instanceof Wrap) {
      const wrapper = this._container.resolve<WrapStatement>(column.Wrapper, [column.Column, this._builder.TableAlias]);
      column = wrapper.wrap();
    } else {
      column = _columnWrap(column, this._builder.TableAlias, this.IsAggregate);

      if (val instanceof ModelBase) {
        val = val.PrimaryKeyValue;
      } else {
        const dsc = extractModelDescriptor(this._model);
        let converter: ValueConverter = null;
        if (dsc && dsc.Converters.has(this._column as string)) {
          converter = this._container.resolve<ValueConverter>(dsc.Converters.get(this._column as string).Class);
        } else {
          const converters = this._container.get<Map<string, any>>('__orm_db_value_converters__');
          if (converters && this._value && converters.has(this._value.constructor.name)) {
            converter = this._container.resolve<ValueConverter>(converters.get(this._value.constructor.name));
            val = converter.toDB(val, null, null);
          }
        }

        val = converter
          ? converter.toDB(
            this._value,
            null,
            dsc.Columns.find((x) => x.Name === this._column),
          )
          : this._value;
      }
    }

    return {
      Bindings: isNullableQuery ? [] : [val],
      Statements: [`${column} ${this._operator.toUpperCase()}${binding}`],
    };
  }
}

@NewInstance()
export class SqlJoinStatement extends JoinStatement {
  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent: T): IQueryStatement {
    return new SqlJoinStatement({
      ...this._options,
      builder: parent as SelectQueryBuilder,
    })
  }

  public build(): IQueryStatementResult {
    const method = this._options.method === JoinMethod.RECURSIVE ? JoinMethod.INNER : this._options.method ?? JoinMethod.LEFT;

    if (this._options.query) {
      return {
        Bindings: this._options.query.Bindings ?? [],
        Statements: [`${method} ${this._options.query.Query}`],
      };
    }

    const sourceModel = this._options.sourceModel ? extractModelDescriptor(this._options.sourceModel) : null;
    const joinModel = this._options.joinModel ? extractModelDescriptor(this._options.joinModel) : null;
    const sourceModelDriver = sourceModel ? sourceModel.Driver : this._options.builder ? this._options.builder.Driver : null;
    const joinModelDriver = !joinModel ? this._options.joinTableDriver : joinModel.Driver;

    if (!sourceModelDriver) {
      throw new InvalidArgument(`Cannot determine source model driver. Please provide sourceModel or use builder with defined model/table`);
    }

    if (!joinModelDriver) {
      throw new InvalidArgument(`Cannot determine join model driver. Please provide joinModel or use joinTableDriver option`);
    }

    if (sourceModelDriver.constructor.name !== joinModelDriver.constructor.name) {
      throw new InvalidArgument(`Cannot join models with different drivers. Source model ${sourceModel.Name} uses ${sourceModelDriver.constructor.name} driver, while join model ${joinModel.Name} uses ${joinModelDriver.constructor.name} driver.`);
    }

    /**
     * Set owner table alias if not set
     * To avoid errors of NON_UNIQUE columns in joins
     */
    if (!this._options.builder.TableAlias) {
      this._options.builder.setAlias(`${sourceModelDriver.Options.AliasSeparator}${this._options.builder.Table}${sourceModelDriver.Options.AliasSeparator}`);
    }

    const sourceTableAlias = this._options.builder.TableAlias;
    const joinTableAlias = this._options.joinTableAlias ? this._options.joinTableAlias : `${joinModelDriver.Options.AliasSeparator}${joinModel.Name}${joinModelDriver.Options.AliasSeparator}`;

    let sourceTable = sourceModel ? sourceModel.TableName : this._options.builder ? this._options.builder.Table : null;
    let joinTable = joinModel ? joinModel.TableName : this._options.joinTable;


    if (this._whereBuilder) {
      this._whereBuilder.setAlias(joinTableAlias);
    }

    if (!sourceTable) {
      throw new InvalidArgument(`Cannot determine source table for join. Please provide sourceModel or use builder with defined model/table`);
    }

    if (!joinTable) {
      throw new InvalidArgument(`Cannot determine join table for join. Please provide joinModel or use joinTable option`);
    }

    if (sourceTableAlias) {
      sourceTable = `\`${sourceModelDriver.Options.Database}\`.\`${sourceTable}\` as \`${sourceTableAlias}\``;
    }

    if (joinTableAlias) {
      joinTable = `\`${joinModelDriver.Options.Database}\`.\`${joinTable}\` as \`${joinTableAlias}\``;
    }



    const primaryKey = sourceTableAlias ? `\`${sourceTableAlias}\`.${this._options.sourceTablePrimaryKey}` : `\`${sourceTable}\`.${this._options.sourceTablePrimaryKey}`;
    const foreignKey = joinTableAlias ? `\`${joinTableAlias}\`.${this._options.joinTableForeignKey}` : `\`${joinTable}\`.${this._options.joinTableForeignKey}`;

    return {
      Bindings: [],
      Statements: [`${method} ${joinTable} ON ${primaryKey} = ${foreignKey}`],
    };
  }
}

@NewInstance()
export class SqlInStatement extends InStatement {
  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent: T): IQueryStatement {
    return new SqlInStatement(this._column, this._val, this._not, parent as SelectQueryBuilder);
  }

  public build(): IQueryStatementResult {
    const exprr = this._not ? 'NOT IN' : 'IN';
    let column = _columnWrap(this._column, this._builder.TableAlias);

    return {
      Bindings: this._val,
      Statements: [`${column} ${exprr} (${this._val.map(() => '?').join(',')})`],
    };
  }
}

@NewInstance()
export class SqlColumnStatement extends ColumnStatement {
  public clone(): SqlColumnStatement {
    return new SqlColumnStatement(this._column, this._alias, this._tableAlias, this.Descriptor);
  }

  public build(): IQueryStatementResult {
    let exprr = '';

    if (this.IsWildcard) {
      exprr = '*';
    } else {
      exprr = `\`${this._column}\``;

      if (this._alias) {
        exprr += ` as \`${this._alias}\``;
      }
    }

    if (this._tableAlias) {
      exprr = `\`${this._tableAlias}\`.${exprr}`;
    }

    return {
      Bindings: [],
      Statements: [exprr],
    };
  }
}

@NewInstance()
export class SqlColumnMethodStatement extends ColumnMethodStatement {
  public clone(): SqlColumnMethodStatement {
    return new SqlColumnMethodStatement(this._column, this._method, this._alias, this._tableAlias);
  }

  public build(): IQueryStatementResult {
    let _exprr = '';

    if (this.IsWildcard) {
      _exprr = `${this._method}(${this._column})`;
    } else {
      _exprr = `${this._method}(\`${this._column}\`)`;
    }

    if (this._alias) {
      _exprr += ` as \`${this._alias}\``;
    }

    return {
      Bindings: [] as any[],
      Statements: [_exprr],
    };
  }
}

@NewInstance()
export abstract class SqlDateWrapper extends DateWrapper {
  public wrap(): string {
    if (this._tableAlias) {
      return `DATE(\`${this._tableAlias}\`.\`${this._value}\`)`;
    }

    return `DATE(\`${this._value}\`)`;
  }
}

export abstract class SqlDateTimeWrapper extends DateTimeWrapper {
  public wrap(): string {
    if (this._tableAlias) {
      return `DATETIME(\`${this._tableAlias}\`.\`${this._value}\`)`;
    }

    return `DATETIME(\`${this._value}\`)`;
  }
}

@NewInstance()
export class SqlColumnRawStatement extends ColumnRawStatement {
  public clone(): SqlColumnRawStatement {
    return new SqlColumnRawStatement(this.RawQuery);
  }

  public build(): IQueryStatementResult {
    return {
      Bindings: this.RawQuery.Bindings,
      Statements: [this.RawQuery.Query],
    };
  }
}

@NewInstance()
export class SqlWhereQueryStatement extends WhereQueryStatement {
  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(_parent: T): IQueryStatement {
    return new SqlWhereQueryStatement(this._builder.clone());
  }

  public build() {
    const _compiler = new SqlWhereCompiler();
    const _result = _compiler.where(this._builder);

    return {
      Bindings: _result.bindings,
      Statements: _result.expression && _result.expression !== '' ? [`( ${_result.expression} )`] : [],
    };
  }
}

@NewInstance()
export class SqlExistsQueryStatement extends ExistsQueryStatement {
  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent: T): IQueryStatement {
    return new SqlExistsQueryStatement(parent as SelectQueryBuilder, this._not);
  }

  public build(): IQueryStatementResult {
    let exprr = '';
    const compiled = this._builder.toDB();

    if (this._not) {
      exprr += `NOT EXISTS ( ${compiled.expression} )`;
    } else {
      exprr += `EXISTS ( ${compiled.expression} )`;
    }

    return {
      Bindings: compiled.bindings,
      Statements: [exprr],
    };
  }
}
