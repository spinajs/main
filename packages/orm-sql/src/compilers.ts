/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-empty-interface */
/* eslint-disable prettier/prettier */
import { InvalidOperation, InvalidArgument } from '@spinajs/exceptions';
import { LimitBuilder, DropTableQueryBuilder, AlterColumnQueryBuilder, TableCloneQueryCompiler, ColumnStatement, OnDuplicateQueryBuilder, IJoinCompiler, DeleteQueryBuilder, IColumnsBuilder, IColumnsCompiler, ICompilerOutput, ILimitBuilder, LimitQueryCompiler, IGroupByCompiler, InsertQueryBuilder, IOrderByBuilder, IWhereBuilder, IWhereCompiler, OrderByBuilder, QueryBuilder, SelectQueryBuilder, UpdateQueryBuilder, SelectQueryCompiler, TableQueryCompiler, TableQueryBuilder, ColumnQueryBuilder, ColumnQueryCompiler, RawQuery, IQueryBuilder, OrderByQueryCompiler, OnDuplicateQueryCompiler, IJoinBuilder, IndexQueryCompiler, IndexQueryBuilder, IRecursiveCompiler, IWithRecursiveBuilder, ForeignKeyBuilder, ForeignKeyQueryCompiler, IGroupByBuilder, AlterTableQueryBuilder, CloneTableQueryBuilder, AlterTableQueryCompiler, ColumnAlterationType, AlterColumnQueryCompiler, TableAliasCompiler, DropTableCompiler, ValueConverter, DropEventQueryBuilder, TableHistoryQueryCompiler, EventQueryBuilder, EventIntervalDesc } from '@spinajs/orm';
import { use } from 'typescript-mix';
import { NewInstance, Inject, Container, IContainer } from '@spinajs/di';
import _ from 'lodash';

@NewInstance()
export class SqlTableAliasCompiler implements TableAliasCompiler {
  public compile(builder: IQueryBuilder, tbl?: string) {
    let table = '';

    if (builder.Database) {
      table += `\`${builder.Database}\`.`;
    }

    table += `\`${tbl ? tbl : builder.Table}\``;

    if (builder.TableAlias) {
      table += ` as \`${builder.TableAlias}\``;
    }

    return table;
  }
}

@NewInstance()
export abstract class SqlQueryCompiler<T extends QueryBuilder> extends SelectQueryCompiler {
  constructor(protected _builder: T, protected _container: IContainer) {
    super();

    if (_builder === null && _builder === undefined) {
      throw new InvalidArgument('builder cannot be null or undefined');
    }
  }

  protected tryConvertValue(v: any) {
    let val = v;
    const converters = this._container.get<Map<string, any>>('__orm_db_value_converters__');
    if (converters && v && converters.has(v.constructor.name)) {
      const converter = this._container.resolve<ValueConverter>(converters.get(v.constructor.name));
      val = converter.toDB(val, null, null);
    }

    return val;
  }

  public abstract compile(): ICompilerOutput;
}

@NewInstance()
export class SqlOrderByQueryCompiler extends OrderByQueryCompiler {
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
    const bindings : string[] = [];

    if (sort) {
      stmt = ` ORDER BY ${sort.column} ${sort.order}`;
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
export class SqlLimitQueryCompiler extends LimitQueryCompiler {
  protected _builder: LimitBuilder<unknown>;

  constructor(builder: LimitBuilder<unknown>) {
    super();

    if (!builder) {
      throw new InvalidOperation('builder cannot be null or undefined');
    }

    this._builder = builder;
  }

  public compile(): ICompilerOutput {
    const limits = this._builder.getLimits();
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
  public where(builder: IWhereBuilder<unknown>) {
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
export interface SqlSelectQueryCompiler extends IWhereCompiler, IColumnsCompiler, IJoinCompiler, IGroupByCompiler, IRecursiveCompiler {}

@NewInstance()
@Inject(Container)
export class SqlSelectQueryCompiler extends SqlQueryCompiler<SelectQueryBuilder> {
  @use(SqlWhereCompiler, SqlColumnsCompiler, TableAliasCompiler, SqlJoinCompiler, SqlWithRecursiveCompiler, SqlGroupByCompiler) this: this;

  constructor(_container: IContainer, builder: SelectQueryBuilder) {
    super(builder, _container);
  }

  public compile(): ICompilerOutput {
    if (this._builder.CteRecursive) {
      return this.recursive(this._builder as IWithRecursiveBuilder);
    }

    const columns = this.select();
    const from = this.from();
    const limit = this.limit();
    const sort = this.sort();
    const where = this.where(this._builder as IWhereBuilder<unknown>);
    const join = this.join(this._builder as IJoinBuilder);
    const group = this.group(this._builder as IGroupByBuilder);

    const expression = columns + ' ' + from + (join.expression ? ` ${join.expression}` : '') + (where.expression ? ` WHERE ${where.expression}` : '') + group.expression + sort.expression + limit.expression;

    const bindings = [];
    bindings.push(...join.bindings);
    bindings.push(...where.bindings);
    bindings.push(...sort.bindings);
    bindings.push(...limit.bindings);
    bindings.push(...group.bindings);

    return {
      bindings,
      expression: expression.trim(),
    };
  }

  protected limit() {
    const compiler = this._container.resolve<LimitQueryCompiler>(LimitQueryCompiler, [this._builder as ILimitBuilder<unknown>]);
    return compiler.compile();
  }

  protected sort() {
    const compiler = this._container.resolve<OrderByQueryCompiler>(OrderByQueryCompiler, [this._builder as IOrderByBuilder]);
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
    return 'FROM ' + this._container.resolve(TableAliasCompiler).compile(this._builder);
  }
}

// tslint:disable-next-line
export interface SqlUpdateQueryCompiler extends IWhereCompiler {}

@NewInstance()
@Inject(Container)
export class SqlUpdateQueryCompiler extends SqlQueryCompiler<UpdateQueryBuilder<unknown>> {
  @use(SqlWhereCompiler, TableAliasCompiler) this: this;

  constructor(protected _container: IContainer, builder: UpdateQueryBuilder<unknown>) {
    super(builder, _container);
  }

  public compile(): ICompilerOutput {
    const table = this.table();
    const set = this.set();
    const where = this.where(this._builder);

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
      const v = (this._builder.Value as never)[`${prop}`] as any;

      exprr.push(`\`${prop}\` = ?`);

      bindings = bindings.concat(this.tryConvertValue(v));
    }

    return {
      bindings,
      expression: exprr.join(','),
    };
  }

  protected table() {
    return `UPDATE ${this._container.resolve(TableAliasCompiler).compile(this._builder)} SET`;
  }
}

// tslint:disable-next-line
export interface SqlDeleteQueryCompiler extends IWhereCompiler {}

@NewInstance()
@Inject(Container)
export class SqlDeleteQueryCompiler extends SqlQueryCompiler<DeleteQueryBuilder<unknown>> {
  @use(SqlWhereCompiler, TableAliasCompiler) this: this;

  constructor(_container: IContainer, builder: DeleteQueryBuilder<unknown>) {
    super(builder, _container);
  }

  public compile() {
    const _bindings = [];
    const _from = this.from();
    const _limit = this.limit();
    const _where = this.where(this._builder);

    let _expression = '';

    _expression = _from + (_where.expression ? ` WHERE ${_where.expression}` : '') + _limit.expression;

    _bindings.push(..._where.bindings);
    _bindings.push(..._limit.bindings);

    return {
      bindings: _bindings,
      expression: _expression.trim(),
    };
  }

  protected limit() {
    const compiler = this._container.resolve<LimitQueryCompiler>(LimitQueryCompiler, [this._builder]);
    return compiler.compile();
  }

  protected from() {
    return `DELETE FROM ${this._container.resolve(TableAliasCompiler).compile(this._builder)}`;
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

    const parent = this._builder.getParent() as InsertQueryBuilder;

    const valueMap = parent.getColumns().map((c: ColumnStatement) => c.Column);
    const bindings = this._builder.getColumnsToUpdate().map((c: string | RawQuery): any => {
      if (_.isString(c)) {
        return parent.Values[0][valueMap.indexOf(c)];
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
@Inject(Container)
export class SqlInsertQueryCompiler extends SqlQueryCompiler<InsertQueryBuilder> {
  @use(TableAliasCompiler) this: this;

  constructor(_container: IContainer, builder: InsertQueryBuilder) {
    super(builder, _container);
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

  protected upsort() {
    if (this._builder.Update) {
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
      const toInsert = val
        .filter((v, i) => {
          // eslint-disable-next-line security/detect-object-injection
          const descriptor = (this._builder.getColumns()[i] as ColumnStatement).Descriptor;
          if (descriptor) {
            if (!descriptor.Nullable && (v === null || v === undefined) && !descriptor.AutoIncrement) {
              throw new InvalidArgument(`value column ${descriptor.Name} cannot be null`);
            }

            if (descriptor.AutoIncrement && descriptor.PrimaryKey) return false;
          }

          return true;
        })
        .map((v) => {
          if (v === undefined) {
            return 'DEFAULT';
          }

          if (v === null) {
            return 'NULL';
          }

          bindings.push(this.tryConvertValue(v));
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
      .filter((c) => {
        const descriptor = (c as ColumnStatement).Descriptor;
        if (descriptor && descriptor.AutoIncrement && descriptor.PrimaryKey) return false;
        return true;
      })
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
    return `INSERT${this._builder.Ignore ? ' IGNORE' : ''} INTO ${this._container.resolve(TableAliasCompiler).compile(this._builder)}`;
  }
}

@NewInstance()
@Inject(Container)
export class SqlDropTableQueryCompiler extends DropTableCompiler {
  constructor(protected container: Container, protected builder: DropTableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    const exists = this.builder.Exists ? ' IF EXISTS' : '';
    const exprr = `DROP TABLE${exists} ${this.container.resolve(TableAliasCompiler).compile(this.builder)}`;

    return {
      bindings: [],
      expression: exprr,
    };
  }
}

export interface SqlAlterTableQueryCompiler {}

@NewInstance()
@Inject(Container)
export class SqlAlterTableQueryCompiler extends AlterTableQueryCompiler {
  constructor(protected container: Container, protected builder: AlterTableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput[] {
    const _table = this._table();
    let _outputs: ICompilerOutput[] = [];

    if (this.builder.DroppedColumns.length !== 0) {
      _outputs = _outputs.concat(
        this.builder.DroppedColumns.map((c) => {
          return {
            bindings: [],
            expression: `${_table} DROP COLUMN ${c}`,
          };
        }),
      );
    }

    if (this.builder.NewTableName) {
      _outputs.push({
        bindings: [],
        expression: `${_table} RENAME TO ${this.container.resolve(TableAliasCompiler).compile(this.builder, this.builder.NewTableName)}`,
      });
    }

    if (this.builder.Columns.length !== 0) {
      _outputs = _outputs.concat(
        this.builder.Columns.map((c) => {
          const compiler = this.container.resolve(AlterColumnQueryCompiler, [c]).compile();

          return {
            bindings: compiler.bindings,
            expression: `${_table} ${compiler.expression}`,
          };
        }),
      );
    }

    return _outputs;
  }

  protected _table() {
    return `ALTER TABLE ${this.container.resolve(TableAliasCompiler).compile(this.builder)}`;
  }
}

export interface SqlTableCloneQueryCompiler {}

@NewInstance()
@Inject(Container)
export class SqlTableCloneQueryCompiler extends TableCloneQueryCompiler {
  @use(TableAliasCompiler) this: this;

  constructor(protected container: Container, protected builder: CloneTableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput[] {
    const _tblName = this.container.resolve(TableAliasCompiler).compile(this.builder, this.builder.CloneSource);
    const _table = this._table();

    const out1: ICompilerOutput = {
      bindings: [],
      expression: `${_table} LIKE ${_tblName}`,
    };

    if (!this.builder.Shallow) {
      const fOut =
        this.builder.Filter !== undefined
          ? this.builder.Filter.toDB()
          : {
              bindings: [],

              // if no filter is provided, copy all the data
              expression: `SELECT * FROM ${_tblName}`,
            };

      const fExprr = `INSERT INTO \`${this.builder.Table}\` ${fOut.expression}`;

      return [
        out1,
        {
          bindings: fOut.bindings,
          expression: fExprr,
        },
      ];
    }

    return [out1];
  }

  protected _table() {
    return `CREATE${this.builder.Temporary ? ' TEMPORARY ' : ' '}TABLE ${this.container.resolve(TableAliasCompiler).compile(this.builder)}`;
  }
}

export interface SqlTruncateTableQueryCompiler {}

@NewInstance()
export class SqlTruncateTableQueryCompiler extends TableQueryCompiler {
  constructor(protected container: Container, protected builder: TableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    return {
      bindings: [],
      expression: `TRUNCATE TABLE ${this.container.resolve(TableAliasCompiler).compile(this.builder)}`,
    };
  }
}

@NewInstance()
@Inject(Container)
export class SqlTableHistoryQueryCompiler extends TableHistoryQueryCompiler {
  constructor(protected container: Container, protected builder: TableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput[] {
    const tblAliasCompiler = this.container.resolve(TableAliasCompiler);
    const hTtblName = tblAliasCompiler.compile(this.builder, `${this.builder.Table}__history`);
    const tblName = tblAliasCompiler.compile(this.builder, `${this.builder.Table}`);
    const hTriggerName = `${this.builder.Table}__history`;
    const tblTriggerName = this.builder.Table;

    const dropUnique = this.builder.Columns.filter((c) => c.Unique).map((c) => {
      return {
        bindings: [],
        expression: `ALTER TABLE ${hTtblName} DROP INDEX ${c.Name}`,
      };
    });

    const pKey = this.builder.Columns.find((c) => c.PrimaryKey);

    return [
      // clone table
      {
        bindings: [],
        expression: `CREATE TABLE ${hTtblName} LIKE ${tblAliasCompiler.compile(this.builder)}`,
      },
      ...dropUnique,
      {
        bindings: [],
        expression: `ALTER TABLE ${hTtblName} 
                      CHANGE COLUMN ${pKey.Name} ${pKey.Name} INT NOT NULL ,
                     DROP PRIMARY KEY;`,
      },

      // remove primary key & add history columns
      {
        bindings: [],
        expression: `ALTER TABLE ${hTtblName} ADD __action__ VARCHAR(8) DEFAULT 'insert' FIRST, ADD __revision__ INT(6) NOT NULL AFTER __action__, ADD __start__ DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER __revision__, ADD __end__ DATETIME AFTER __start__`,
      },

      {
        bindings: [],
        expression: `ALTER TABLE ${hTtblName}  ADD PRIMARY KEY (${pKey.Name}, __revision__)`,
      },

      {
        bindings: [],
        expression: `DELIMITER $$ 
        CREATE TRIGGER ${hTriggerName}__insert_trigger BEFORE INSERT ON ${hTtblName} FOR EACH ROW 
        BEGIN 
          DECLARE rev INT;
          SET rev = (SELECT IFNULL(MAX(__revision__), 0) FROM ${hTtblName} WHERE Id = NEW.Id);
          SET NEW.__revision__ = rev + 1; 
        END;`,
      },

      // create tracking triggers
      {
        bindings: [],
        expression: `DROP TRIGGER IF EXISTS ${tblTriggerName}__insert_trigger`,
      },
      {
        bindings: [],
        expression: `DROP TRIGGER IF EXISTS ${tblTriggerName}__update_trigger`,
      },
      {
        bindings: [],
        expression: `DROP TRIGGER IF EXISTS ${tblTriggerName}__delete_trigger`,
      },

      // insert into history table & update __end__ date for all operations
      {
        bindings: [],
        expression: `DELIMITER $$ 
                     CREATE TRIGGER ${tblTriggerName}__insert_trigger AFTER INSERT ON ${tblName} FOR EACH ROW BEGIN 
                        DECLARE rev INT;
                        SET rev = (SELECT IFNULL(MAX(__revision__), 0) FROM ${hTtblName} WHERE Id = NEW.Id);
                        UPDATE ${hTtblName} SET __end__ = NOW() WHERE Id = NEW.Id AND __revision__ = rev;
                        INSERT INTO ${hTtblName} SELECT 'insert', 0, NOW(), NULL, d.* FROM ${tblName} AS d WHERE d.${pKey.Name} = NEW.${pKey.Name}; 
                    END;`,
      },
      {
        bindings: [],
        expression: `DELIMITER $$ 
                     CREATE TRIGGER ${tblTriggerName}__update_trigger AFTER UPDATE ON ${tblName} FOR EACH ROW BEGIN 
                        DECLARE rev INT;
                        SET rev = (SELECT IFNULL(MAX(__revision__), 0) FROM ${hTtblName} WHERE Id = NEW.Id);
                        UPDATE ${hTtblName} SET __end__ = NOW() WHERE Id = NEW.Id AND __revision__ = rev;
                        INSERT INTO ${hTtblName} SELECT 'update', 0, NOW(), NULL, d.* FROM ${tblName} AS d WHERE d.${pKey.Name} = NEW.${pKey.Name}; 
                      END;`,
      },
      {
        bindings: [],
        expression: `DELIMITER $$ 
                     CREATE TRIGGER ${tblTriggerName}__delete_trigger BEFORE DELETE ON ${tblName} FOR EACH ROW BEGIN 
                        DECLARE rev INT;
                        SET rev = (SELECT IFNULL(MAX(__revision__), 0) FROM ${hTtblName} WHERE Id = NEW.Id);
                        UPDATE ${hTtblName} SET __end__ = NOW() WHERE Id = NEW.Id AND __revision__ = rev;
                        INSERT INTO ${hTtblName} SELECT 'delete', 0, NOW(), NULL, d.* FROM ${tblName} AS d WHERE d.${pKey.Name} = NEW.${pKey.Name}; 
                     END;`,
      },
    ];
  }
}

export interface SqlTableQueryCompiler {}

@NewInstance()
@Inject(Container)
export class SqlTableQueryCompiler extends TableQueryCompiler {
  constructor(protected container: Container, protected builder: TableQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput[] {
    const _table = this._table();
    const _columns = this._columns();
    const _keys = this._foreignKeys();
    const _primaryKey = this._primaryKeys();

    const createOutput: ICompilerOutput = {
      bindings: [],
      expression: `${_table} (${_columns} ${_primaryKey ? ',' + _primaryKey : ''} ${_keys ? ',' + _keys : ''})`,
    };

    if (this.builder.TrackHistory) {
      const hCompiler = this.container.resolve(TableHistoryQueryCompiler, [this.builder]);
      return [createOutput, ...hCompiler.compile()];
    } else {
      return [createOutput];
    }
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
      return `PRIMARY KEY (${_keys})`;
    }

    return '';
  }

  protected _table() {
    return `CREATE${this.builder.Temporary ? ' TEMPORARY ' : ' '}TABLE ${this.builder.CheckExists ? 'IF NOT EXISTS ' : ''}${this.container.resolve(TableAliasCompiler).compile(this.builder)}`;
  }
}

@NewInstance()
export class SqlColumnQueryCompiler implements ColumnQueryCompiler {
  protected _statementsMappings = {
    set: (builder: ColumnQueryBuilder) => `SET(${builder.Args[0].map((a: string) => `'${a}\'`).join(',')})`,
    string: (builder: ColumnQueryBuilder) => `VARCHAR(${builder.Args[0] ? builder.Args[0] : 255})`,
    boolean: () => `TINYINT(1)`,
    float: (builder: ColumnQueryBuilder) => {
      const _precision = builder.Args[0] ? builder.Args[0] : 8;
      const _scale = builder.Args[1] ? builder.Args[1] : 2;
      return `${builder.Type.toUpperCase()}(${_precision},${_scale})`;
    },
    double: (builder: ColumnQueryBuilder) => this._statementsMappings.float(builder),
    decimal: (builder: ColumnQueryBuilder) => this._statementsMappings.float(builder),
    enum: (builder: ColumnQueryBuilder) => `${builder.Type.toUpperCase()}(${builder.Args[0].map((a: any) => `'${a}'`).join(',')})`,
    binary: (builder: ColumnQueryBuilder) => `BINARY(${builder.Args[0] ?? 255}`,
    smallint: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    tinyint: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    mediumint: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    int: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    bigint: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    tinytext: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    mediumtext: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    longtext: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    text: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    bit: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    date: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    time: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    dateTime: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    timestamp: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    json: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    tinyblob: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    mediumblob: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),
    longblob: (builder: ColumnQueryBuilder) => builder.Type.toUpperCase(),

    // COLUMN ADDITIONA PROPS
    unsigned: () => 'UNSIGNED',
    charset: (builder: ColumnQueryBuilder) => `CHARACTER SET '${builder.Charset}'`,
    collation: (builder: ColumnQueryBuilder) => `COLLATE '${builder.Collation}'`,
    notnull: () => `NOT NULL`,
    default: () => this._defaultCompiler(),
    autoincrement: () => `AUTO_INCREMENT`,
    comment: (builder: ColumnQueryBuilder) => `COMMENT '${builder.Comment}'`,
  };

  constructor(protected builder: ColumnQueryBuilder) {
    if (!builder) {
      throw new Error('column query builder cannot be null');
    }
  }

  public compile(): ICompilerOutput {
    const _stmt: string[] = [];

    _stmt.push(`\`${this.builder.Name}\``);
    _stmt.push(this._statementsMappings[this.builder.Type](this.builder));

    if (this.builder.Unsigned) {
      _stmt.push(this._statementsMappings.unsigned());
    }
    if (this.builder.Charset) {
      _stmt.push(this._statementsMappings.charset(this.builder));
    }
    if (this.builder.Collation) {
      _stmt.push(this._statementsMappings.collation(this.builder));
    }
    if (this.builder.NotNull) {
      _stmt.push(this._statementsMappings.notnull());
    }
    if (this.builder.Default) {
      _stmt.push(this._statementsMappings.default());
    }
    if (this.builder.AutoIncrement) {
      _stmt.push(this._statementsMappings.autoincrement());
    }
    if (this.builder.Comment) {
      _stmt.push(this._statementsMappings.comment(this.builder));
    }
    if (this.builder.Unique) {
      _stmt.push('UNIQUE');
    }

    return {
      bindings: [],
      expression: _stmt.filter((x) => !_.isEmpty(x)).join(' '),
    };
  }

  protected _defaultCompiler() {
    let _stmt = '';

    if (_.isNil(this.builder.Default) || (_.isNil(this.builder.Default.Query) && _.isNil(this.builder.Default.Value))) {
      return _stmt;
    }

    if (_.isString(this.builder.Default.Value)) {
      _stmt = `DEFAULT '${this.builder.Default.Value.trim()}'`;
    } else if (_.isNumber(this.builder.Default.Value)) {
      _stmt = `DEFAULT ${this.builder.Default.Value}`;
    } else if (this.builder.Default.Query instanceof RawQuery) {
      _stmt = `DEFAULT ${this.builder.Default.Query.Query}`;
    }

    return _stmt;
  }
}

@NewInstance()
export class SqlAlterColumnQueryCompiler extends SqlColumnQueryCompiler {
  constructor(builder: AlterColumnQueryBuilder) {
    super(builder as ColumnQueryBuilder);
  }

  public compile(): ICompilerOutput {
    const builder = this.builder as AlterColumnQueryBuilder;

    if (builder.AlterType === ColumnAlterationType.Rename) {
      const bld = this.builder as AlterColumnQueryBuilder;
      return {
        bindings: [],
        expression: `RENAME COLUMN \`${bld.OldName}\` TO \`${bld.Name}\``,
      };
    }

    const cDefinition = super.compile();
    if (builder.AlterType === ColumnAlterationType.Add) {
      return {
        bindings: cDefinition.bindings,
        expression: `ADD ${cDefinition.expression} ${builder.AfterColumn ? `AFTER \`${builder.AfterColumn}\`` : ''}`,
      };
    }

    if (builder.AlterType === ColumnAlterationType.Modify) {
      return {
        bindings: cDefinition.bindings,
        expression: `MODIFY ${cDefinition.expression}`,
      };
    }
  }
}

@NewInstance()
@Inject(Container)
export class SqlEventQueryCompiler extends SqlQueryCompiler<EventQueryBuilder> {
  constructor(container: IContainer, builder: EventQueryBuilder) {
    super(builder, container);
  }

  public compile(): ICompilerOutput {
    const schedule = this._createSchedule();
    const action = this._action();

    return {
      bindings: action.bindings,
      expression: `CREATE EVENT ${this._builder.Name} ON SCHEDULE ${schedule} DO BEGIN ${action.expression} END`,
    };
  }

  _createSchedule() {
    if (this._builder.FromNowInverval) {
      return `AT CURRENT_TIMESTAMP + INTERVAL ${this._getInterval(this._builder.FromNowInverval)}`;
    }

    if (this._builder.At) {
      return `AT ${this._builder.At.toFormat(`yyyy-mm-dd HH:mm:ss`)}`;
    }

    if (this._builder.EveryInterval) {
      return `EVERY ${this._getInterval(this._builder.EveryInterval)}`;
    }
  }

  _getInterval(desc: EventIntervalDesc) {
    return Object.getOwnPropertyNames(desc)
      .map((x) => {
        if ((desc as any)[`${x}`] > 0) {
          return `${(desc as any)[`${x}`]} ${x.toUpperCase()}`;
        }

        return null;
      })
      .find((x) => x !== null);
  }

  _action(): { expression: string; bindings: any[] } {
    if (this._builder.RawSql) {
      const res = this._builder.RawSql.build();
      return {
        expression: res.Statements.join(';'),
        bindings: res.Bindings,
      };
    } else {
      const qResult = this._builder.Queries.reduce(
        (prev, curr) => {
          const res = curr.toDB();

          if (Array.isArray(res)) {
            res.forEach((x) => {
              prev.bindings = prev.bindings.concat(x.bindings);
              prev.expression.push(x.expression);
            });
          } else {
            prev.bindings = prev.bindings.concat(res.bindings);
            prev.expression.push(res.expression);
          }

          return prev;
        },
        {
          expression: [],
          bindings: [],
        },
      );

      return {
        expression: qResult.expression.join(';'),
        bindings: qResult.bindings,
      };
    }
  }
}

@NewInstance()
@Inject(Container)
export class SqlDropEventQueryCompiler extends SqlQueryCompiler<DropEventQueryBuilder> {
  constructor(container: IContainer, builder: DropEventQueryBuilder) {
    super(builder, container);
  }

  public compile(): ICompilerOutput {
    return {
      bindings: [],
      expression: `DROP EVENT IF EXISTS ${this._builder.Name}`,
    };
  }
}
