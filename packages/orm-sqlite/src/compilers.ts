/* eslint-disable security/detect-object-injection */
/* eslint-disable prettier/prettier */

import { SqlColumnQueryCompiler, SqlTableQueryCompiler, SqlOnDuplicateQueryCompiler, SqlInsertQueryCompiler } from '@spinajs/orm-sql';
import { ICompilerOutput, OrderByBuilder, OrderByQueryCompiler, RawQuery, OnDuplicateQueryBuilder, ColumnStatement, InsertQueryBuilder } from '@spinajs/orm';
import { NewInstance, Inject, Container, Autoinject } from '@spinajs/di';
import _ = require('lodash');

@NewInstance()
export class SqliteOrderByCompiler extends OrderByQueryCompiler {
  protected _builder: OrderByBuilder;

  constructor(builder: OrderByBuilder) {
    super();

    if (!builder) {
      throw new Error('builder cannot be null or undefined');
    }

    this._builder = builder;
  }
  public compile(): ICompilerOutput {
    const sort = this._builder.getSort();
    let stmt = '';
    const bindings = [] as unknown[];

    if (sort) {
      stmt = ` ORDER BY \`${sort.column}\` ${sort.order.toLowerCase() === 'asc' ? 'ASC' : 'DESC'}`;
    }

    return {
      bindings,
      expression: stmt,
    };
  }
}
@NewInstance()
export class SqliteOnDuplicateQueryCompiler extends SqlOnDuplicateQueryCompiler {
  protected _builder: OnDuplicateQueryBuilder;

  constructor(builder: OnDuplicateQueryBuilder) {
    super(builder);
  }

  public compile() {
    const columns = this._builder.getColumnsToUpdate().map((c: string | RawQuery): string => {
      if (_.isString(c)) {
        return `${c} = ?`;
      } else {
        return c.Query;
      }
    });

    const bindings = _.flatMap(this._builder.getColumnsToUpdate(), (c: string | RawQuery) => {
      if (_.isString(c)) {
        const cIndex = this._builder
          .getParent()
          .getColumns()
          .findIndex((col: ColumnStatement) => (_.isString(col.Column) ? col.Column === c : null));
        return this._builder.getParent().Values[0][cIndex];
      } else {
        return c.Bindings;
      }
    });

    return {
      bindings,
      expression: `ON CONFLICT(${this._builder.getColumn().join(',')}) DO UPDATE SET ${columns.join(',')}`,
    };
  }
}

@NewInstance()
@Inject(Container)
export class SqliteTableQueryCompiler extends SqlTableQueryCompiler {
  public compile(): ICompilerOutput {
    const _table = this._table();
    const _columns = this._columns();
    const _foreignKeys = this._foreignKeys();

    return {
      bindings: [],
      expression: `${_table} (${_columns} ${_foreignKeys ? ',' + _foreignKeys : ''})`,
    };
  }
}

@NewInstance()
export class SqliteInsertQueryCompiler extends SqlInsertQueryCompiler {
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

  protected into() {
    return `INSERT${this._builder.Ignore ? ' OR IGNORE' : ''} INTO \`${this._builder.Table}\``;
  }
}

@NewInstance()
export class SqliteColumnCompiler extends SqlColumnQueryCompiler {
  public compile(): ICompilerOutput {
    const _stmt: string[] = [];

    _stmt.push(`\`${this.builder.Name}\``);

    switch (this.builder.Type) {
      case 'binary':
      case 'tinyblob':
      case 'mediumblob':
      case 'longblob':
        _stmt.push('BLOB');
        break;
      case 'string':
      case 'text':
      case 'mediumtext':
      case 'tinytext':
      case 'longtext':
      case 'date':
      case 'dateTime':
      case 'time':
      case 'set':
        _stmt.push(`TEXT`);
        break;
      case 'float':
      case 'double':
        _stmt.push(`REAL`);
        break;
      case 'decimal':
        _stmt.push(`DECIMAL`);
        break;
      case 'int':
      case 'tinyint':
      case 'smallint':
      case 'mediumint':
      case 'bigint':
      case 'boolean':
        _stmt.push('INTEGER');
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
    if (this.builder.Comment) {
      _stmt.push(`COMMENT '${this.builder.Comment}'`);
    }
    if (this.builder.PrimaryKey) {
      _stmt.push(`PRIMARY KEY`);
    }
    if (this.builder.AutoIncrement) {
      _stmt.push(`AUTOINCREMENT`);
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
