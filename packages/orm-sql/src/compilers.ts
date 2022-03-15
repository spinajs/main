/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-empty-interface */
/* eslint-disable prettier/prettier */
import { InvalidOperation, InvalidArgument } from '@spinajs/exceptions';
import { ColumnStatement, OnDuplicateQueryBuilder, IJoinCompiler, DeleteQueryBuilder, IColumnsBuilder, IColumnsCompiler, ICompilerOutput, ILimitBuilder, ILimitCompiler, IGroupByCompiler, InsertQueryBuilder, IOrderByBuilder, IWhereBuilder, IWhereCompiler, OrderByBuilder, QueryBuilder, SelectQueryBuilder, UpdateQueryBuilder, SelectQueryCompiler, TableQueryCompiler, TableQueryBuilder, ColumnQueryBuilder, ColumnQueryCompiler, RawQuery, IQueryBuilder, OrderByQueryCompiler, OnDuplicateQueryCompiler, IJoinBuilder, IndexQueryCompiler, IndexQueryBuilder, IRecursiveCompiler, IWithRecursiveBuilder, ForeignKeyBuilder, ForeignKeyQueryCompiler, IGroupByBuilder, AlterTableQueryBuilder } from '@spinajs/orm';
import { use } from 'typescript-mix';
import { NewInstance, Inject, Container, Autoinject } from '@spinajs/di';
import _ = require('lodash');

interface ITableAliasCompiler {
  tableAliasCompiler(builder: QueryBuilder): string;
}

class TableAliasCompiler implements ITableAliasCompiler {
  public tableAliasCompiler(builder: IQueryBuilder) {
    let table = '';

    if (builder.Schema) {
      table += `\`${builder.Schema}\`.`;
    }

    table += `\`${builder.Table}\``;

    if (builder.TableAlias) {
      table += ` as \`${builder.TableAlias}\``;
    }

    return table;
  }
}

@NewInstance()
export abstract class SqlQueryCompiler<T extends QueryBuilder> extends SelectQueryCompiler {
  protected _builder: T;

  constructor(builder: T) {
    super();

    if (builder === null && builder === undefined) {
      throw new InvalidOperation('builder cannot be null or undefined');
    }

    this._builder = builder;
  }

  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export class SqlOrderQueryByCompiler extends OrderByQueryCompiler {
  protected _builder: OrderByBuilder;

  constructor(builder: OrderByBuilder) {
    super();

    if (!builder) {
      throw new InvalidOperation('builder cannot be null or undefined');
    }

    this._builder = builder;
  }

  public compile(): ICompilerOutput {
    const sort = this._builder.getSort();
    let stmt = '';
    const bindings = [];

    if (sort) {
      stmt = ` ORDER BY ? ?`;
      bindings.push(sort.column, sort.order);
    }

    return {
      bindings,
      expression: stmt,
    };
  }
}
@NewInstance()
export class SqlWithRecursiveCompiler implements IRecursiveCompiler {
  public recursive(builder: IWithRecursiveBuilder): ICompilerOutput {
    const statement = builder.CteRecursive.build();

    let exprr = `WITH RECURSIVE recursive_cte(${statement.Statements[0]}) AS`;
    exprr += ` ( `;

    exprr += statement.Statements[1];
    exprr += ` UNION ALL `;
    exprr += statement.Statements[2];

    exprr += ` ) `;
    exprr += 'SELECT * FROM recursive_cte';

    return {
      bindings: statement.Bindings,
      expression: exprr,
    };
  }
}

@NewInstance()
export class SqlForeignKeyQueryCompiler implements ForeignKeyQueryCompiler {
  constructor(protected _builder: ForeignKeyBuilder) {
    if (!_builder) {
      throw new Error('foreign key query builder cannot be null');
    }
  }

  public compile(): ICompilerOutput {
    const exprr = `FOREIGN KEY (${this._builder.ForeignKeyField}) REFERENCES ${this._builder.Table}(${this._builder.PrimaryKey}) ON DELETE ${this._builder.OnDeleteAction} ON UPDATE ${this._builder.OnUpdateAction}`;

    return {
      bindings: [],
      expression: exprr,
    };
  }
}

@NewInstance()
export class SqlLimitCompiler implements ILimitCompiler {
  public limit(builder: ILimitBuilder): ICompilerOutput {
    const limits = builder.getLimits();
    const bindings = [];
    let stmt = '';

    if (limits.limit > 0) {
      stmt += ` LIMIT ?`;
      bindings.push(limits.limit);
    } else {
      if (limits.offset > 0) {
        stmt += ` LIMIT 18446744073709551615`;
      }
    }

    if (limits.offset > 0) {
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
export class SqlGroupByCompiler implements IGroupByCompiler {
  public group(builder: IGroupByBuilder): ICompilerOutput {
    let bindings = [];
    let stmt = ' GROUP BY ';
    const builds = builder.GroupStatements.map((x) => x.build());

    stmt += builds.map((x) => x.Statements).join(',');
    bindings = builds.map((x) => x.Bindings);

    return {
      bindings,
      expression: builds.length != 0 ? stmt : '',
    };
  }
}

@NewInstance()
export class SqlColumnsCompiler implements IColumnsCompiler {
  public columns(builder: IColumnsBuilder) {
    return {
      bindings: [] as any[],
      expression: builder
        .getColumns()
        .map((c) => {
          return c.build().Statements[0];
        })
        .join(','),
    };
  }
}

@NewInstance()
export class SqlWhereCompiler implements IWhereCompiler {
  public where(builder: IWhereBuilder) {
    const where: string[] = [];
    const bindings: any[] = [];

    builder.Statements.map((x) => {
      return x.build();
    }).forEach((r) => {
      where.push(...r.Statements);

      if (Array.isArray(r.Bindings)) {
        bindings.push(...r.Bindings);
      }
    });

    return {
      bindings,
      expression: where.join(` ${builder.Op.toUpperCase()} `),
    };
  }
}

@NewInstance()
export class SqlJoinCompiler implements IJoinCompiler {
  public join(builder: IJoinBuilder) {
    const result = builder.JoinStatements.map((s) => s.build());

    return {
      bindings: _.flatMap(result, (r) => r.Bindings),
      expression: _.flatMap(result, (r) => r.Statements).join(' '),
    };
  }
}

// tslint:disable-next-line
export interface SqlSelectQueryCompiler extends IWhereCompiler, ILimitCompiler, IColumnsCompiler, ITableAliasCompiler, IJoinCompiler, IGroupByCompiler, IRecursiveCompiler {}

@NewInstance()
export class SqlSelectQueryCompiler extends SqlQueryCompiler<SelectQueryBuilder> {
  @use(SqlWhereCompiler, SqlLimitCompiler, SqlColumnsCompiler, TableAliasCompiler, SqlJoinCompiler, SqlWithRecursiveCompiler, SqlGroupByCompiler) this: this;

  @Autoinject()
  private Container: Container;

  constructor(builder: SelectQueryBuilder) {
    super(builder);
  }

  public compile(): ICompilerOutput {
    if (this._builder.CteRecursive) {
      return this.recursive(this._builder as IWithRecursiveBuilder);
    }

    const columns = this.select();
    const from = this.from();
    const limit = this.limit(this._builder as ILimitBuilder);
    const sort = this.sort(this._builder as IOrderByBuilder);
    const where = this.where(this._builder as IWhereBuilder);
    const join = this.join(this._builder as IJoinBuilder);
    const group = this.group(this._builder as IGroupByBuilder);

    const expression = columns + ' ' + from + (join.expression ? ` ${join.expression}` : '') + (where.expression ? ` WHERE ${where.expression}` : '') + group.expression + sort.expression + limit.expression;

    const bindings = [];
    bindings.push(...join.bindings);
    bindings.push(...where.bindings);
    bindings.push(...limit.bindings);
    bindings.push(...sort.bindings);
    bindings.push(...group.bindings);

    return {
      bindings,
      expression: expression.trim(),
    };
  }

  protected sort(builder: IOrderByBuilder) {
    const compiler = this.Container.resolve<OrderByQueryCompiler>(OrderByQueryCompiler, [builder]);
    return compiler.compile();
  }

  protected select() {
    let _stmt = 'SELECT ';

    if (this._builder.IsDistinct) {
      _stmt += 'DISTINCT ';
    }

    if (this._builder.getColumns().length === 0) {
      return _stmt + '*';
    }

    return _stmt + this.columns(this._builder).expression;
  }

  protected from() {
    return 'FROM ' + this.tableAliasCompiler(this._builder);
  }
}

// tslint:disable-next-line
export interface SqlUpdateQueryCompiler extends IWhereCompiler, ITableAliasCompiler {}

@NewInstance()
export class SqlUpdateQueryCompiler extends SqlQueryCompiler<UpdateQueryBuilder> {
  @use(SqlWhereCompiler, TableAliasCompiler) this: this;

  constructor(builder: UpdateQueryBuilder) {
    super(builder);
  }

  public compile(): ICompilerOutput {
    const table = this.table();
    const set = this.set();
    const where = this.where(this._builder as IWhereBuilder);

    const bindings = [];
    bindings.push(...set.bindings);
    bindings.push(...where.bindings);

    return {
      bindings,
      expression: `${table} ${set.expression} WHERE ${where.expression}`,
    };
  }

  protected set() {
    let bindings: any[] = [];
    const exprr = [];

    for (const prop of Object.keys(this._builder.Value)) {
      const val = (this._builder.Value as never)[`${prop}`];

      exprr.push(`\`${prop}\` = ?`);
      bindings = bindings.concat(val);
    }

    return {
      bindings,
      expression: exprr.join(','),
    };
  }

  protected table() {
    return `UPDATE ${this.tableAliasCompiler(this._builder)} SET`;
  }
}

// tslint:disable-next-line
export interface SqlDeleteQueryCompiler extends IWhereCompiler, ITableAliasCompiler {}

@NewInstance()
export class SqlDeleteQueryCompiler extends SqlQueryCompiler<DeleteQueryBuilder> {
  @use(SqlWhereCompiler, TableAliasCompiler) this: this;

  public compile() {
    const _bindings = [];
    const _from = this.from();
    const _limit = this.limit();
    const _where = this.where(this._builder as IWhereBuilder);

    let _expression = '';

    if (this._builder.Truncate) {
      _expression = `TRUNCATE TABLE ${this.tableAliasCompiler(this._builder)}`;
    } else {
      _expression = _from + (_where.expression ? ` WHERE ${_where.expression}` : '') + _limit.expression;
    }

    _bindings.push(..._where.bindings);
    _bindings.push(..._limit.bindings);

    return {
      bindings: _bindings,
      expression: _expression.trim(),
    };
  }

  protected limit() {
    const _limits = this._builder.getLimits();
    const _bindings = [];
    let _stmt = ' ';

    if (_limits.limit > 0) {
      _stmt += `LIMIT ?`;
      _bindings.push(_limits.limit);
    }

    return {
      bindings: _bindings,
      expression: _stmt,
    };
  }

  protected from() {
    return `DELETE FROM ${this.tableAliasCompiler(this._builder)}`;
  }
}
@NewInstance()
export class SqlOnDuplicateQueryCompiler implements OnDuplicateQueryCompiler {
  protected _builder: OnDuplicateQueryBuilder;

  constructor(builder: OnDuplicateQueryBuilder) {
    this._builder = builder;
  }

  public compile() {
    const columns = this._builder
      .getColumnsToUpdate()
      .map((c: string | RawQuery): string => {
        if (_.isString(c)) {
          return `\`${c}\` = ?`;
        } else {
          return c.Query;
        }
      })
      .join(',');

    const valueMap = this._builder
      .getParent()
      .getColumns()
      .map((c: ColumnStatement) => c.Column);
    const bindings = this._builder.getColumnsToUpdate().map((c: string | RawQuery): any => {
      if (_.isString(c)) {
        return this._builder.getParent().Values[0][valueMap.indexOf(c)];
      } else {
        return c.Bindings;
      }
    });

    return {
      bindings,
      expression: `ON DUPLICATE KEY UPDATE ${columns}`,
    };
  }
}

@NewInstance()
export class SqlIndexQueryCompiler extends IndexQueryCompiler {
  protected _builder: IndexQueryBuilder;

  constructor(builder: IndexQueryBuilder) {
    super();

    this._builder = builder;
  }

  public compile(): ICompilerOutput {
    return {
      bindings: [],
      expression: `CREATE ${this._builder.Unique ? 'UNIQUE ' : ''}INDEX \`${this._builder.Name}\` ON \`${this._builder.Table}\` (${this._builder.Columns.map((c) => `\`${c}\``).join(',')});`,
    };
  }
}

@NewInstance()
export class SqlInsertQueryCompiler extends SqlQueryCompiler<InsertQueryBuilder> {
  @Autoinject()
  protected _container: Container;

  constructor(builder: InsertQueryBuilder) {
    super(builder);
  }

  public compile() {
    const into = this.into();
    const columns = this.columns();
    const values = this.values();
    const onDuplicate = this.onDuplicate();

    return {
      bindings: values.bindings.concat(onDuplicate.bindings),
      expression: `${into} ${columns} ${values.data} ${onDuplicate.expression}`.trim(),
    };
  }

  protected onDuplicate() {
    if (this._builder.DuplicateQueryBuilder !== null && this._builder.DuplicateQueryBuilder !== undefined) {
      return this._container.resolve(OnDuplicateQueryCompiler, [this._builder.DuplicateQueryBuilder]).compile();
    }

    return {
      bindings: [],
      expression: '',
    };
  }

  protected values() {
    if (this._builder.Values.length === 0) {
      throw new InvalidArgument('values count invalid');
    }

    const bindings: any[] = [];
    let data = 'VALUES ';

    data += this._builder.Values.map((val) => {
      const toInsert = val.map((v, i) => {
        // eslint-disable-next-line security/detect-object-injection
        const descriptor = (this._builder.getColumns()[i] as ColumnStatement).Descriptor;

        if (descriptor && !descriptor.Nullable && (v === null || v === undefined) && !descriptor.AutoIncrement) {
          throw new InvalidArgument(`value column ${descriptor.Name} cannot be null`);
        }

        if (v === undefined) {
          return 'DEFAULT';
        }

        if (v === null) {
          return 'NULL';
        }

        bindings.push(v);
        return '?';
      });
      return `(` + toInsert.join(',') + ')';
    }).join(',');

    return {
      bindings,
      data,
    };
  }

  protected columns() {
    const columns = this._builder
      .getColumns()
      .map((c) => {
        return (c as ColumnStatement).Column;
      })
      .map((c) => {
        return `\`${c instanceof RawQuery ? c.Query : c}\``;
      });

    if (columns.length === 0) {
      throw new InvalidArgument('invalid column count');
    }

    return `(` + columns.join(',') + ')';
  }

  protected into() {
    return `INSERT${this._builder.Ignore ? ' IGNORE' : ''} INTO \`${this._builder.Table}\``;
  }
}

export interface SqlAlterTableQueryCompiler extends ITableAliasCompiler {}

@NewInstance()
@Inject(Container)
export class SqlAlterTableQueryCompiler extends TableQueryCompiler {
  @use(TableAliasCompiler) this: this;

  constructor(protected container: Container, protected builder: AlterTableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    const _table = this._table();

    if(this.builder)

    
  }

  protected _table() {
    return `AlTER TABLE ${this.tableAliasCompiler(this.builder)}`;
  }
}

export interface SqlTableQueryCompiler extends ITableAliasCompiler {}

@NewInstance()
@Inject(Container)
export class SqlTableQueryCompiler extends TableQueryCompiler {
  @use(TableAliasCompiler) this: this;

  constructor(protected container: Container, protected builder: TableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    const _table = this._table();
    const _columns = this._columns();
    const _keys = [this._primaryKeys(), this._foreignKeys()];

    return {
      bindings: [],
      expression: `${_table} (${_columns} ${_keys.filter((k) => k && k !== '').join(',')})`,
    };
  }

  protected _columns() {
    return this.builder.Columns.map((c) => {
      return this.container.resolve(ColumnQueryCompiler, [c]).compile().expression;
    }).join(',');
  }

  protected _foreignKeys() {
    return this.builder.ForeignKeys.map((f) => {
      return this.container.resolve(ForeignKeyQueryCompiler, [f]).compile().expression;
    }).join(',');
  }

  protected _primaryKeys() {
    const _keys = this.builder.Columns.filter((x) => x.PrimaryKey)
      .map((c) => `\`${c.Name}\``)
      .join(',');

    if (!_.isEmpty(_keys)) {
      return `, PRIMARY KEY (${_keys})`;
    }

    return '';
  }

  protected _table() {
    return `CREATE${this.builder.Temporary ? "TEMPORARY " : " "}TABLE ${this.builder.CheckExists ? 'IF NOT EXISTS ' : ''}${this.tableAliasCompiler(this.builder)}`;
  }
}

@NewInstance()
export class SqlColumnQueryCompiler implements ColumnQueryCompiler {
  constructor(protected builder: ColumnQueryBuilder) {
    if (!builder) {
      throw new Error('column query builder cannot be null');
    }
  }

  public compile(): ICompilerOutput {
    const _stmt: string[] = [];

    _stmt.push(`\`${this.builder.Name}\``);

    switch (this.builder.Type) {
      case 'set':
        _stmt.push(`SET(${this.builder.Args[0].map((a: string) => `'${a}\'`).join(',')})`);
        break;
      case 'string':
        const _len = this.builder.Args[0] ? this.builder.Args[0] : 255;
        _stmt.push(`VARCHAR(${_len})`);
        break;
      case 'boolean':
        _stmt.push(`TINYINT(1)`);
        break;
      case 'float':
      case 'double':
      case 'decimal':
        const _precision = this.builder.Args[0] ? this.builder.Args[0] : 8;
        const _scale = this.builder.Args[1] ? this.builder.Args[1] : 2;
        _stmt.push(`${this.builder.Type.toUpperCase()}(${_precision},${_scale})`);
        break;
      case 'enum':
        const _enums = this.builder.Args[0].map((a: any) => `'${a}'`).join(',');
        _stmt.push(`${this.builder.Type.toUpperCase()}(${_enums})`);
        break;
      case 'binary':
        _stmt.push(`BINARY(${this.builder.Args[0] ?? 255}`);
        break;
      default:
        _stmt.push(this.builder.Type.toUpperCase());
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
    if (this.builder.AutoIncrement) {
      _stmt.push('AUTO_INCREMENT');
    }
    if (this.builder.Comment) {
      _stmt.push(`COMMENT '${this.builder.Comment}'`);
    }

    return {
      bindings: [],
      expression: _stmt.filter((x) => !_.isEmpty(x)).join(' '),
    };
  }

  protected _defaultCompiler() {
    let _stmt = '';

    if (_.isNil(this.builder.Default) || (_.isString(this.builder.Default) && _.isEmpty(this.builder.Default.trim()))) {
      return _stmt;
    }

    if (_.isString(this.builder.Default)) {
      _stmt = `DEFAULT '${this.builder.Default.trim()}'`;
    } else if (_.isNumber(this.builder.Default)) {
      _stmt = `DEFAULT ${this.builder.Default}`;
    } else if (this.builder.Default instanceof RawQuery) {
      _stmt = `DEFAULT ${this.builder.Default.Query}`;
    }

    return _stmt;
  }
}
