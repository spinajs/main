import { Container, Inject, NewInstance, IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ColumnType } from '../../enums.js';
import { DefaultValueBuilder, ColumnAlterationType } from '../../interfaces.js';

const EXACT_TYPES: ColumnType[] = [ColumnType.STRING, ColumnType.TEXT, ColumnType.TINY_TEXT, ColumnType.MEDIUM_TEXT, ColumnType.LONG_TEXT];

@NewInstance()
@Inject(Container)
export class ColumnQueryBuilder {
  public Name: string;
  public Unique: boolean;
  public Unsigned: boolean;
  public AutoIncrement: boolean;
  public Default: DefaultValueBuilder<ColumnQueryBuilder>;
  public PrimaryKey: boolean;
  public Comment: string;
  public Charset: string;
  public Collation: string;
  public Exact: boolean;
  public NotNull: boolean;
  public Type: ColumnType;
  public Args: any[];

  /**
   * When false the column compiler must not emit an inline PRIMARY KEY; the table compiler
   * emits a table-level constraint instead. Dialects that cannot express a composite key
   * inline ( SQLite ) clear this. Defaults to true.
   */
  public InlinePrimaryKey: boolean;

  constructor(protected container: IContainer, name: string, type: ColumnType, ...args: any[]) {
    this.Name = name;
    this.Type = type;
    this.Charset = '';
    this.Args = [];
    this.AutoIncrement = false;
    this.NotNull = false;
    this.Collation = '';
    this.Exact = false;
    this.Comment = '';
    this.Unique = false;
    this.Unsigned = false;
    this.InlinePrimaryKey = true;

    this.Args.push(...args);
  }

  public notNull() {
    this.NotNull = true;

    return this;
  }

  public unique() {
    this.Unique = true;

    return this;
  }

  public unsigned() {
    this.Unsigned = true;

    return this;
  }

  public autoIncrement() {
    this.AutoIncrement = true;

    return this;
  }

  public default(): DefaultValueBuilder<ColumnQueryBuilder> {
    this.Default = this.container.resolve(DefaultValueBuilder<ColumnQueryBuilder>, [this]);
    return this.Default;
  }

  public primaryKey() {
    this.PrimaryKey = true;
    return this;
  }

  public comment(comment: string) {
    this.Comment = comment;

    return this;
  }

  public charset(charset: string) {
    this.Charset = charset;

    return this;
  }

  public collation(collation: string) {
    this.Collation = collation;

    return this;
  }

  /**
   * Compares and orders values byte for byte, with the dialect's binary collation: case and accent variants are
   * different values. An explicit `collation()` wins. String and text columns only.
   */
  public exact() {
    if (!EXACT_TYPES.includes(this.Type)) {
      throw new InvalidArgument(`exact() applies to string and text columns only, column '${this.Name}' is ${this.Type}`);
    }

    this.Exact = true;

    return this;
  }
}

@Inject(Container)
@NewInstance()
export class AlterColumnQueryBuilder extends ColumnQueryBuilder {
  public AlterType: ColumnAlterationType;
  public AfterColumn: string;
  public OldName: string;

  constructor(container: IContainer, name: string, type: ColumnType, ...args: any[]) {
    super(container, name, type, ...args);
    this.OldName = name;

    // we assume add by default
    this.AlterType = ColumnAlterationType.Add;
  }

  public addColumn() {
    this.AlterType = ColumnAlterationType.Add;

    return this;
  }

  public modify() {
    this.AlterType = ColumnAlterationType.Modify;

    return this;
  }

  public rename(newName: string) {
    this.AlterType = ColumnAlterationType.Rename;
    this.Name = newName;
    return this;
  }

  public after(columnName: string) {
    this.AfterColumn = columnName;
    return this;
  }
}
