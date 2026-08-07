import { IQueryStatement, JoinMethod, LazyQueryStatement, QueryBuilder, SelectQueryBuilder, WhereBuilder, ModelBase, SqlOperator, BetweenStatement, JoinStatement, ColumnStatement, ColumnRawStatement, InStatement, InSetStatement, IQueryStatementResult, RawQueryStatement, WhereStatement, ExistsQueryStatement, ColumnMethodStatement, WhereQueryStatement, WithRecursiveStatement, GroupByStatement, RawQuery, DateWrapper, DateTimeWrapper, Wrap, WrapStatement, ValueConverter, extractModelDescriptor, escapeLikeValue, IdentifierQuoter, LIKE_ESCAPE_CHARACTER, SET_DELIMITER } from '@spinajs/orm';
/* eslint-disable prettier/prettier */
import { SqlWhereCompiler } from './compilers.js';
import { Autoinject, NewInstance } from '@spinajs/di';

import { InvalidArgument } from '@spinajs/exceptions';

/**
 * Exported so driver packages can wrap a column exactly the way the shared
 * statements do — a driver writing its own dialect statement must not have to
 * re-derive alias rules. Quoting itself comes from the driver's own
 * {@link IdentifierQuoter}, which is why it is a parameter rather than an import.
 */
export function _columnWrap(quoter: IdentifierQuoter, column: string, tableAlias: string | undefined, isAggregate?: boolean): string {
  if (tableAlias && !isAggregate) {
    return `${quoter.quote(tableAlias)}.${quoter.quote(column)}`;
  }

  return quoter.quote(column);
}


/**
 * Copies the injected quoter onto a hand-constructed clone.
 *
 * `clone()` builds statements with `new`, which bypasses the container — so property
 * injection never runs on a clone and `this.Quoter` would be undefined the moment the
 * cloned statement compiled. Every clone of a statement that quotes anything goes
 * through here.
 */
function _carryQuoter<T extends { Quoter: IdentifierQuoter }>(clone: T, source: { Quoter: IdentifierQuoter }): T {
  clone.Quoter = source.Quoter;
  return clone;
}

/**
 * The `clone(parent?)` contract, and which statements below participate in it.
 *
 * A statement that holds a live reference to a BUILDER must rebind that reference to the
 * builder it is handed. `SelectQueryBuilder.clone()` and `WhereBuilder.clone()` pass the new
 * builder to every statement they copy, precisely so the copies stop pointing at the original.
 * Anything that reads `builder.TableAlias` at BUILD time and kept the original produced SQL
 * naming an alias the cloned query never declares.
 *
 * Rebinding statements: {@link SqlWhereStatement} (`_builder`), {@link SqlInStatement}
 * (`_builder`), {@link SqlJoinStatement} (`_options.builder`), {@link SqlWhereQueryStatement}
 * (nested where-builder), {@link SqlExistsQueryStatement} (sub-select correlation),
 * {@link SqlLazyQueryStatement} (deferred evaluation context) and
 * {@link SqlWithRecursiveStatement} (`_query`, the owning query).
 *
 * Statements that deliberately do NOT rebind — {@link SqlBetweenStatement},
 * {@link SqlGroupByStatement}, {@link SqlColumnStatement}, {@link SqlColumnMethodStatement},
 * {@link SqlInSetStatement} (and its per-driver subclasses), {@link SqlRawStatement},
 * {@link SqlColumnRawStatement} — hold no builder at all. They carry the table alias as a
 * VALUE, snapshotted when they were created; `SelectQueryBuilder.setAlias()` re-stamps that
 * value on every statement of the builder that owns them, so a clone follows its own builder's
 * alias without needing a reference to it.
 */

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

  /**
   * REBINDS to the builder it is handed — the deferred callback is evaluated against
   * `this.context`, so a clone that kept the source builder would resolve its aliases (and,
   * for a correlated EXISTS, its whole correlation) against the query it was cloned from.
   */
  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent?: T): SqlLazyQueryStatement {
    return new SqlLazyQueryStatement(this.callback, parent ?? this.context);
  }

  build(): IQueryStatementResult {

    const context = (this.context as SelectQueryBuilder).clone();
    context.setAlias((this.context as SelectQueryBuilder).TableAlias);

    // The correlation link is what tells the callback which OUTER query to correlate against.
    // `clone()` above already copies it, but `setAlias()` does not, and a context built from a
    // builder that was never a sub-query has none — restate it so it can never be lost here.
    context.correlateWith((this.context as SelectQueryBuilder).CorrelationSource);

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
  /**
   * REBINDS to the builder it is handed. `_query` is the OWNING query — `withRecursive()`
   * passes `this` — and `build()` mutates it ( it pushes a join before compiling the recursive
   * member ). A clone that kept the source query compiled the CTE of the query it was cloned
   * from and pushed joins into it.
   */
  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent?: T): SqlWithRecursiveStatement {
    return new SqlWithRecursiveStatement(this.container, this._name, (parent as SelectQueryBuilder) ?? this._query, this._rcKeyName, this._pkName);
  }

  public build(): IQueryStatementResult {
    // `clearRecursive()` on both clones is what stops this from recursing forever. `clone()`
    // carries `_cteStatement` over, so a clone compiled here would re-enter the recursive
    // compiler, which clones again — toDB -> compile -> recursive -> build -> toDB, until the
    // stack ran out. The anchor and recursive members of a CTE are plain SELECTs by
    // definition; neither may carry the CTE that contains it.
    const initialQuery = this._query.clone().clearRecursive().clearJoins().toDB();

    // Built from a named options object. This call site still passed the eight POSITIONAL
    // arguments of a signature `JoinStatement` no longer has — its constructor takes one
    // options object — so `_options` was the query builder itself and every field the join
    // needed read back `undefined`.
    //
    // `joinTableDriver` has to be supplied explicitly: the join target is `recursive_cte`, a
    // common table expression rather than a model, so there is no descriptor to read a driver
    // from. It is the source query's own driver by construction — a CTE lives in the same
    // statement, and therefore the same connection, as the query that declares it.
    const joinStmt = this.container.resolve(JoinStatement, [
      {
        builder: this._query,
        sourceModel: this._query.Model,
        joinTable: 'recursive_cte',
        joinTableDriver: this._query.Driver,
        method: JoinMethod.RECURSIVE,
        // The ON clause renders as `<recursing table>.<sourceTablePrimaryKey> =
        // <cte>.<joinTableForeignKey>`. A descendant walk has to match the CHILD's foreign key
        // against the PARENT row already in the CTE — `category.parent_id = cte.Id`. Passing
        // them the other way round produced `category.Id = cte.parent_id`, which walks towards
        // ancestors: the opposite of what a `@Recursive() @HasMany` relation means, and it
        // returned nothing for a root row whose own parent_id is NULL.
        sourceTablePrimaryKey: this._rcKeyName,
        joinTableForeignKey: this._pkName,
        sourceTableAlias: '$recursive$',
        joinTableAlias: '$recursive_cte$',
      },
    ]);
    this._query.JoinStatements.push(joinStmt);
    const additionalQuery = this._query.clone().clearRecursive().clearWhere().setAlias('$recursive$').toDB();
    const cte_columns = this._query
      .getColumns()
      .map((c: ColumnStatement) => c.Column)
      .join(',');

    return {
      Bindings: initialQuery.bindings!.concat(additionalQuery.bindings!),
      Statements: [cte_columns, initialQuery.expression!, additionalQuery.expression!],
    };
  }
}

@NewInstance()
export class SqlBetweenStatement extends BetweenStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public clone(): SqlBetweenStatement {
    return _carryQuoter(new SqlBetweenStatement(this._column, this._val, this._not, this._tableAlias!), this);
  }

  public build(): IQueryStatementResult {
    const exprr = this._not ? 'NOT BETWEEN' : 'BETWEEN';

    return {
      Bindings: this._val,
      Statements: [`${_columnWrap(this.Quoter, this._column, this._tableAlias)} ${exprr} ? AND ?`],
    };
  }
}

@NewInstance()
export class SqlGroupByStatement extends GroupByStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public clone(): SqlGroupByStatement {
    return _carryQuoter(new SqlGroupByStatement(this._expr, this.TableAlias), this);
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
        Statements: [this.Quoter.quote(this._expr)],
      };
    }
  }
}

@NewInstance()
export class SqlWhereStatement extends WhereStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;


  /**
   * REBINDS to the builder it is handed.
   *
   * `build()` reads `this._builder.TableAlias`, and a query's alias is usually assigned AFTER
   * the query was cloned ( `populate()` calls `setAlias()` ). Keeping the source builder here
   * therefore made the clone emit the alias of the query it was cloned from — an alias the
   * clone's own FROM never declares — and the database answered "Unknown column
   * '$Model$.column' in 'where clause'".
   */
  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(_builder?: T): SqlWhereStatement {
    return _carryQuoter(
      new SqlWhereStatement(this._column, this._operator, this._value, (_builder ?? this._builder) as WhereBuilder<unknown>),
      this,
    );
  }

  public build(): IQueryStatementResult {
    const isNullableQuery = this._operator === SqlOperator.NOT_NULL || this._operator === SqlOperator.NULL;
    const binding = isNullableQuery ? '' : ' ?';
    let column = this._column;
    let val = this._value;
    if (this._model) {
      const desc = extractModelDescriptor(this._model);
      const rel = desc!.Relations.get(column as string);
      if (rel) {
        column = rel.ForeignKey;
      }
    }

    if (column instanceof Wrap) {
      const wrapper = this._container.resolve<WrapStatement>(column.Wrapper, [column.Column, this._builder.TableAlias]);
      column = wrapper.wrap();
    } else {
      column = _columnWrap(this.Quoter, column, this._builder.TableAlias, this.IsAggregate);

      if (val instanceof ModelBase) {
        // A composite key unwraps to a tuple, which would bind an array into a single `?`.
        const pk = val.PrimaryKeyValue;
        if (Array.isArray(pk)) {
          throw new InvalidArgument(`cannot use model ${val.constructor.name} as a where value: it has a composite primary key (${val.PrimaryKeyName.join(', ')}). Compare the key columns explicitly.`);
        }
        val = pk;
      } else {
        const dsc = extractModelDescriptor(this._model);
        let converter: ValueConverter | null = null;
        if (dsc && dsc.Converters.has(this._column as string)) {
          converter = this._container.resolve<ValueConverter>(dsc.Converters.get(this._column as string)!.Class);
        } else {
          const converters = this._container.get<Map<string, any>>('__orm_db_value_converters__');
          if (converters && this._value && converters.has(this._value.constructor.name)) {
            converter = this._container.resolve<ValueConverter>(converters.get(this._value.constructor.name));
            val = converter.toDB(val, null as any, null as any, null);
          }
        }

        val = converter
          ? converter.toDB(
            this._value,
            null as any,
            (dsc ? dsc.Columns.find((x) => x.Name === this._column) : null) as any,
            null,
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
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent?: T): IQueryStatement {
    return _carryQuoter(
      new SqlJoinStatement({
        ...this._options,
        builder: (parent as SelectQueryBuilder) ?? this._options.builder,
      }),
      this,
    );
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
      throw new InvalidArgument(`Cannot join models with different drivers. Source model ${sourceModel?.Name} uses ${sourceModelDriver.constructor.name} driver, while join model ${joinModel?.Name} uses ${joinModelDriver.constructor.name} driver.`);
    }

    /**
     * Set owner table alias if not set
     * To avoid errors of NON_UNIQUE columns in joins
     */
    if (!this._options.builder?.TableAlias) {
      this._options.builder?.setAlias(`${sourceModelDriver.Options.AliasSeparator}${this._options.builder?.Table}${sourceModelDriver.Options.AliasSeparator}`);
    }

    const sourceTableAlias = this._options.builder?.TableAlias;
    const joinTableAlias = this._options.joinTableAlias ? this._options.joinTableAlias : `${joinModelDriver.Options.AliasSeparator}${joinModel?.Name}${joinModelDriver.Options.AliasSeparator}`;

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
      const sourceDb = sourceModelDriver.Options.Database;
      if (sourceDb) {
        sourceTable = `${this.Quoter.quote(sourceDb)}.${this.Quoter.quote(sourceTable)} as ${this.Quoter.quote(sourceTableAlias)}`;
      } else {
        sourceTable = `${this.Quoter.quote(sourceTable)} as ${this.Quoter.quote(sourceTableAlias)}`;
      }
    }

    if (joinTableAlias) {
      const joinDb = joinModelDriver.Options.Database;
      if (joinDb) {
        joinTable = `${this.Quoter.quote(joinDb)}.${this.Quoter.quote(joinTable)} as ${this.Quoter.quote(joinTableAlias)}`;
      } else {
        joinTable = `${this.Quoter.quote(joinTable)} as ${this.Quoter.quote(joinTableAlias)}`;
      }
    }



    // NOTE: only the table alias part of the ON keys is escaped here. The join
    // key column names (sourceTablePrimaryKey / joinTableForeignKey) are left
    // as-is on purpose: they come from validated relation descriptors and the
    // existing suite asserts the unquoted form, so escaping them would change
    // byte output for normal identifiers.
    const primaryKey = sourceTableAlias ? `${this.Quoter.quote(sourceTableAlias)}.${this._options.sourceTablePrimaryKey}` : `${this.Quoter.quote(sourceTable)}.${this._options.sourceTablePrimaryKey}`;
    const foreignKey = joinTableAlias ? `${this.Quoter.quote(joinTableAlias)}.${this._options.joinTableForeignKey}` : `${this.Quoter.quote(joinTable)}.${this._options.joinTableForeignKey}`;

    // Conditions supplied via the join callback (e.g. `.leftJoin(rel, b => b.where('Key', 'x'))`)
    // belong in the JOIN's ON clause, not the main WHERE — otherwise an outer
    // join is silently narrowed to an inner one. We compile the join sub-builder's
    // WHERE statements here and append them to ON (the constructor intentionally
    // does NOT merge these into the main builder; see JoinStatement above).
    let onExpression = `${primaryKey} = ${foreignKey}`;
    const onBindings: unknown[] = [];

    if (this._whereBuilder) {
      // Compile join-callback conditions through the shared where-compiler so
      // per-statement AND/OR connectors are honoured here too.
      const compiled = new SqlWhereCompiler().where(this._whereBuilder);
      if (compiled.expression && compiled.expression !== '') {
        onExpression += ` AND ${compiled.expression}`;
        if (Array.isArray(compiled.bindings)) {
          onBindings.push(...compiled.bindings);
        }
      }
    }

    return {
      Bindings: onBindings,
      Statements: [`${method} ${joinTable} ON ${onExpression}`],
    };
  }
}

@NewInstance()
export class SqlInStatement extends InStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent?: T): IQueryStatement {
    return _carryQuoter(new SqlInStatement(this._column, this._val, this._not, (parent ?? this._builder) as SelectQueryBuilder), this);
  }

  public build(): IQueryStatementResult {
    const exprr = this._not ? 'NOT IN' : 'IN';
    const column = _columnWrap(this.Quoter, this._column, this._builder.TableAlias);

    return {
      Bindings: this._val,
      Statements: [`${column} ${exprr} (${this._val.map(() => '?').join(',')})`],
    };
  }
}

/**
 * Portable membership test against a delimited `@Set()` column.
 *
 * Plain equality plus three LIKE patterns — value alone, first, last, in the middle —
 * so it needs no dialect function and no string concatenation operator ( `||` on
 * SQLite, `+` on MSSQL, `CONCAT()` on MySQL: there is no spelling all three accept ).
 * Every driver that ships with spinajs replaces this with its native form; this is
 * what an unknown driver gets, and it is correct rather than fast.
 *
 * This used to emit `FIND_IN_SET`, which exists only in MySQL — on SQLite and MSSQL
 * every `whereInSet` ( and therefore every `withRole` ) died with "no such function"
 * at query time.
 */
@NewInstance()
export class SqlInSetStatement extends InSetStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  build(): IQueryStatementResult {
    const column = _columnWrap(this.Quoter, this._column, this._tableAlias);
    const bindings: string[] = [];

    const expressions = this.values().map((value) => {
      const pattern = escapeLikeValue(value);

      // exact ( the column holds this value alone ), first, last, middle
      bindings.push(value, `${pattern}${SET_DELIMITER}%`, `%${SET_DELIMITER}${pattern}`, `%${SET_DELIMITER}${pattern}${SET_DELIMITER}%`);

      const like = `${column} LIKE ? ESCAPE '${LIKE_ESCAPE_CHARACTER}'`;
      return `(${column} = ? OR ${like} OR ${like} OR ${like})`;
    });

    return {
      Bindings: bindings,
      Statements: [this.combine(expressions)],
    };
  }

  public clone(): IQueryStatement {
    return _carryQuoter(new SqlInSetStatement(this._column, this._val, this._not, this._tableAlias!), this);
  }
}

@NewInstance()
export class SqlColumnStatement extends ColumnStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public clone(): SqlColumnStatement {
    return _carryQuoter(new SqlColumnStatement(this._column, this._alias, this._tableAlias!, this.Descriptor), this);
  }

  public build(): IQueryStatementResult {
    let exprr = '';

    if (this.IsWildcard) {
      exprr = '*';
    } else {
      exprr = this.Quoter.quote(this._column as string);

      if (this._alias) {
        exprr += ` as ${this.Quoter.quote(this._alias)}`;
      }
    }

    if (this._tableAlias) {
      exprr = `${this.Quoter.quote(this._tableAlias)}.${exprr}`;
    }

    return {
      Bindings: [],
      Statements: [exprr],
    };
  }
}

@NewInstance()
export class SqlColumnMethodStatement extends ColumnMethodStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public clone(): SqlColumnMethodStatement {
    return _carryQuoter(new SqlColumnMethodStatement(this._column, this._method, this._alias, this._tableAlias!), this);
  }

  public build(): IQueryStatementResult {
    let _exprr = '';

    if (this.IsWildcard) {
      _exprr = `${this._method}(${this._column})`;
    } else {
      _exprr = `${this._method}(${this.Quoter.quote(this._column as string)})`;
    }

    if (this._alias) {
      _exprr += ` as ${this.Quoter.quote(this._alias)}`;
    }

    return {
      Bindings: [] as any[],
      Statements: [_exprr],
    };
  }
}

@NewInstance()
export abstract class SqlDateWrapper extends DateWrapper {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public wrap(): string {
    if (this._tableAlias) {
      return `DATE(${this.Quoter.quote(this._tableAlias)}.${this.Quoter.quote(this._value as string)})`;
    }

    return `DATE(${this.Quoter.quote(this._value as string)})`;
  }
}

export abstract class SqlDateTimeWrapper extends DateTimeWrapper {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public wrap(): string {
    if (this._tableAlias) {
      return `DATETIME(${this.Quoter.quote(this._tableAlias)}.${this.Quoter.quote(this._value as string)})`;
    }

    return `DATETIME(${this.Quoter.quote(this._value as string)})`;
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
  /**
   * REBINDS the nested where-builder to the builder it is handed, falling back to the parent
   * the nested builder already has so a clone taken without one stays attached to something
   * ( `WhereBuilder`'s constructor dereferences its parent ).
   */
  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(_parent?: T): IQueryStatement {

    // TODO: fix this any cast !
    return new SqlWhereQueryStatement(this._builder.clone((_parent ?? this._builder.Parent ?? this._builder) as any));
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
  /**
   * The sub-select is cloned ( it is owned by this statement, not shared with the outer query )
   * and then RE-CORRELATED to the builder this statement was handed.
   *
   * Re-correlating is the whole point: the sub-select's correlation predicate names the OUTER
   * query's alias, and it is emitted lazily at compile time because that alias is usually
   * assigned after the sub-query is built. Leaving the clone pointing at the source query meant
   * a cloned query's EXISTS either referenced an alias the clone never declared or — because
   * the lazy predicate was appended to the source's sub-builder rather than the clone's — was
   * dropped altogether, leaving an UNCORRELATED `EXISTS (SELECT ...)` that is true for every
   * row. That is how a cloned count query escaped an rbac `readOwn` constraint.
   */
  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(_parent?: T): IQueryStatement {
    const builder = this._builder.clone();

    if (_parent) {
      builder.correlateWith(_parent as unknown as WhereBuilder<any>);
    }

    return new SqlExistsQueryStatement(builder, this._not);
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
      Bindings: compiled.bindings ?? [],
      Statements: [exprr],
    };
  }
}
