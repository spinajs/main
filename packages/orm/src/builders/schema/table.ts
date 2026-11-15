import { Container, Inject, NewInstance } from '@spinajs/di';
import { ColumnType } from '../../enums.js';
import { TruncateTableQueryCompiler, TableQueryCompiler, AlterTableQueryCompiler, QueryContext, TableExistsCompiler, DropTableCompiler, TableCloneQueryCompiler } from '../../interfaces.js';
import type { ICompilerOutput } from '../../interfaces.js';
import type { OrmDriver } from '../../driver.js';
import type { SchemaTouch } from '../../schema-touches.js';
import { QueryBuilder } from '../base.js';
import { SelectQueryBuilder } from '../select.js';
import { ForeignKeyBuilder } from './foreign-key.js';
import { ColumnQueryBuilder, AlterColumnQueryBuilder } from './column.js';

@NewInstance()
export class TableExistsQueryBuilder extends QueryBuilder {
  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver, undefined);

    this.setTable(name);

    this.QueryContext = QueryContext.Select;
  }
  public toDB(): ICompilerOutput {
    return this._container.resolve<TableExistsCompiler>(TableExistsCompiler, [this]).compile();
  }
}

@NewInstance()
export class DropTableQueryBuilder extends QueryBuilder {
  public Exists: boolean;

  constructor(container: Container, driver: OrmDriver, name: string, database?: string) {
    super(container, driver, undefined);

    this.setTable(name);

    if (database) {
      this.database(database);
    }

    this.Exists = false;
    this.QueryContext = QueryContext.Schema;
  }

  public ifExists() {
    this.Exists = true;
    return this;
  }

  protected schemaTouches(): SchemaTouch {
    return [this.Table];
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<DropTableCompiler>(DropTableCompiler, [this]).compile();
  }
}

@NewInstance()
export class AlterTableQueryBuilder extends QueryBuilder {
  protected _columns: ColumnQueryBuilder[];

  public NewTableName: string;

  public DroppedColumns: string[];

  public get Columns() {
    return this._columns;
  }

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver, undefined);

    this.setTable(name);

    this.QueryContext = QueryContext.Schema;
    this._columns = [];
    this.DroppedColumns = [];
  }

  public int: (name: string) => AlterColumnQueryBuilder;
  public bigint: (name: string) => AlterColumnQueryBuilder;
  public tinyint: (name: string) => AlterColumnQueryBuilder;
  public smallint: (name: string) => AlterColumnQueryBuilder;
  public mediumint: (name: string) => AlterColumnQueryBuilder;

  public text: (name: string) => AlterColumnQueryBuilder;
  public tinytext: (name: string) => AlterColumnQueryBuilder;
  public mediumtext: (name: string) => AlterColumnQueryBuilder;
  public smalltext: (name: string) => AlterColumnQueryBuilder;
  public longtext: (name: string) => AlterColumnQueryBuilder;
  public string: (name: string, length?: number) => AlterColumnQueryBuilder;

  public float: (name: string, precision?: number, scale?: number) => AlterColumnQueryBuilder;
  public double: (name: string, precision?: number, scale?: number) => AlterColumnQueryBuilder;
  public decimal: (name: string, precision?: number, scale?: number) => AlterColumnQueryBuilder;
  public boolean: (name: string) => AlterColumnQueryBuilder;
  public bit: (name: string) => AlterColumnQueryBuilder;

  public date: (name: string) => AlterColumnQueryBuilder;
  public dateTime: (name: string) => AlterColumnQueryBuilder;
  public time: (name: string) => AlterColumnQueryBuilder;
  public timestamp: (name: string) => AlterColumnQueryBuilder;
  public enum: (name: string, values: any[]) => AlterColumnQueryBuilder;
  public json: (name: string) => AlterColumnQueryBuilder;

  public binary: (name: string, size: number) => AlterColumnQueryBuilder;

  public tinyblob: (name: string) => AlterColumnQueryBuilder;
  public mediumblob: (name: string) => AlterColumnQueryBuilder;
  public longblob: (name: string) => AlterColumnQueryBuilder;

  /**
   * Renames table
   *
   * @param newTableName - new table name
   */
  public rename(newTableName: string) {
    this.NewTableName = newTableName;
  }

  public dropColumn(column: string) {
    this.DroppedColumns.push(column);
  }

  protected schemaTouches(): SchemaTouch {
    return [this.Table, this.NewTableName];
  }

  public toDB(): ICompilerOutput[] {
    return this._container.resolve<AlterTableQueryCompiler>(AlterTableQueryCompiler, [this]).compile();
  }
}

@NewInstance()
export class TableQueryBuilder extends QueryBuilder {
  public int: (name: string) => ColumnQueryBuilder;
  public bigint: (name: string) => ColumnQueryBuilder;
  public tinyint: (name: string) => ColumnQueryBuilder;
  public smallint: (name: string) => ColumnQueryBuilder;
  public mediumint: (name: string) => ColumnQueryBuilder;

  public text: (name: string) => ColumnQueryBuilder;
  public tinytext: (name: string) => ColumnQueryBuilder;
  public mediumtext: (name: string) => ColumnQueryBuilder;
  public smalltext: (name: string) => ColumnQueryBuilder;
  public longtext: (name: string) => ColumnQueryBuilder;
  public string: (name: string, length?: number) => ColumnQueryBuilder;

  /**
   * Alias for binary(name, 16 ) - uuids are stored as 16-byte BINARY to match
   * the UuidConverter ( which writes a dashed uuid as a 16-byte buffer ).
   */
  public uuid(name: string) {
    return this.binary(name, 16);
  }

  public float: (name: string, precision?: number, scale?: number) => ColumnQueryBuilder;
  public double: (name: string, precision?: number, scale?: number) => ColumnQueryBuilder;
  public decimal: (name: string, precision?: number, scale?: number) => ColumnQueryBuilder;
  public boolean: (name: string) => ColumnQueryBuilder;
  public bit: (name: string) => ColumnQueryBuilder;

  public date: (name: string) => ColumnQueryBuilder;
  public dateTime: (name: string) => ColumnQueryBuilder;
  public time: (name: string) => ColumnQueryBuilder;
  public timestamp: (name: string) => ColumnQueryBuilder;
  public enum: (name: string, values: any[]) => ColumnQueryBuilder;
  public json: (name: string) => ColumnQueryBuilder;

  public binary: (name: string, size: number) => ColumnQueryBuilder;

  public tinyblob: (name: string) => ColumnQueryBuilder;
  public mediumblob: (name: string) => ColumnQueryBuilder;
  public longblob: (name: string) => ColumnQueryBuilder;

  public ifExists(): TableQueryBuilder {
    this._checkExists = true;
    return this;
  }

  /**
   * Mark table as temporary
   */
  public temporary(): TableQueryBuilder {
    this._temporary = true;
    return this;
  }

  /**
   * Turn on history trackign for this table
   * Each change & row will be tracked, and all history of changes can be accessed
   */
  public trackHistory() {
    this._trackHistory = true;
    return this;
  }

  public set: (name: string, allowed: string[]) => ColumnQueryBuilder;

  public get Columns() {
    return this._columns;
  }

  public get ForeignKeys() {
    return this._foreignKeys;
  }

  protected _columns: ColumnQueryBuilder[];

  protected _foreignKeys: ForeignKeyBuilder[];

  protected _comment: string;

  protected _charset: string;

  protected _checkExists!: boolean;

  protected _temporary: boolean;

  protected _trackHistory: boolean;

  public get CheckExists() {
    return this._checkExists;
  }

  public get Temporary() {
    return this._temporary;
  }

  public get TrackHistory() {
    return this._trackHistory;
  }

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver, undefined);

    this._charset = '';
    this._comment = '';
    this._columns = [];
    this._foreignKeys = [];
    this._temporary = false;
    this._trackHistory = false;

    this.setTable(name);

    this.QueryContext = QueryContext.Schema;
  }

  public increments(name: string) {
    return this.int(name).autoIncrement().notNull().primaryKey();
  }

  public comment(comment: string) {
    this._comment = comment;
  }

  public charset(charset: string) {
    this._charset = charset;
  }

  public foreignKey(foreignKey: string) {
    const builder = new ForeignKeyBuilder();
    builder.foreignKey(foreignKey);
    this._foreignKeys.push(builder);

    return builder;
  }

  protected schemaTouches(): SchemaTouch {
    return [this.Table];
  }

  public toDB(): ICompilerOutput | ICompilerOutput[] {
    return this._container.resolve<TableQueryCompiler>(TableQueryCompiler, [this]).compile();
  }
}

@NewInstance()
@Inject(Container)
export class TruncateTableQueryBuilder extends QueryBuilder {
  constructor(protected container: Container, protected driver: OrmDriver) {
    super(container, driver);
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<TruncateTableQueryCompiler>(TruncateTableQueryCompiler, [this.Container, this]).compile();
  }
}

@NewInstance()
@Inject(Container)
export class CloneTableQueryBuilder extends QueryBuilder {
  protected _cloneSrc: string;

  protected _temporary: boolean;

  protected _shallow: boolean;

  protected _filter!: SelectQueryBuilder;

  public get CloneSource() {
    return this._cloneSrc;
  }

  public get Temporary() {
    return this._temporary;
  }

  public get Shallow() {
    return this._shallow;
  }

  public get Filter() {
    return this._filter;
  }

  constructor(protected container: Container, protected driver: OrmDriver) {
    super(container, driver);

    this._shallow = true;
    this._cloneSrc = '';
    this._temporary = false;
  }

  /**
   * Clones table structure without data
   * Shorthand for createTable(( table) => table.clone("new"));
   *
   * @param srcTable - source table name
   * @param newTable - target table name
   */
  public shallowClone(srcTable: string, newTable: string) {
    this.setTable(newTable);
    this._cloneSrc = srcTable;

    return this;
  }

  /**
   * Clones table with data
   *
   * @param srcTable - source table name
   * @param newTable - target table name
   * @param filter - data filter, set null if all data is to be cloned
   */
  public async deepClone(srcTable: string, newTable: string, filter?: (query: SelectQueryBuilder) => void) {
    this.setTable(newTable);
    this._cloneSrc = srcTable;
    this._shallow = false;

    if (filter) {
      this._filter = new SelectQueryBuilder(this._container, this._driver);
      this._filter.setTable(this._cloneSrc);
      filter(this._filter);
    }

    return this;
  }

  protected schemaTouches(): SchemaTouch {
    return [this.Table];
  }

  public toDB(): ICompilerOutput[] {
    return this._container.resolve<TableCloneQueryCompiler>(TableCloneQueryCompiler, [this]).compile();
  }
}

Object.values(ColumnType).forEach((type) => {
  (TableQueryBuilder.prototype as any)[type] = function (this: TableQueryBuilder, name: string, ...args: any[]) {
    const _builder = new ColumnQueryBuilder(this.Container, name, type, ...args);
    this._columns.push(_builder);
    return _builder;
  };
});

Object.values(ColumnType).forEach((type) => {
  (AlterTableQueryBuilder.prototype as any)[type] = function (this: AlterTableQueryBuilder, name: string, ...args: any[]) {
    const _builder = new AlterColumnQueryBuilder(this.Container, name, type, ...args);
    this._columns.push(_builder);
    return _builder;
  };
});
