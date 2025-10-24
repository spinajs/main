/* eslint-disable prettier/prettier */
import { ValueConverter } from './../src/interfaces.js';
import { join, normalize, resolve } from 'path';
import { IColumnDescriptor, ColumnQueryCompiler, DropTableCompiler, TableExistsCompiler, SelectQueryCompiler, ICompilerOutput, DeleteQueryCompiler, InsertQueryCompiler, UpdateQueryCompiler, TableQueryCompiler, QueryBuilder, Builder } from '../src/index.js';
import { OrmDriver, TransactionCallback } from './../src/driver.js';
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

// Table info mapping for test models
const TEST_TABLE_INFO: Record<string, IColumnDescriptor[]> = {
  TestTable1: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'VARCHAR',
      MaxLength: 255,
      Comment: '',
      DefaultValue: null,
      NativeType: 'VARCHAR',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Bar',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'OwnerId',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: true,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  TestTable2: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'VARCHAR',
      MaxLength: 255,
      Comment: '',
      DefaultValue: null,
      NativeType: 'VARCHAR',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Bar',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  TestTable3: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'VARCHAR',
      MaxLength: 255,
      Comment: '',
      DefaultValue: null,
      NativeType: 'VARCHAR',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Property3',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  TestTable4: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'VARCHAR',
      MaxLength: 255,
      Comment: '',
      DefaultValue: null,
      NativeType: 'VARCHAR',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Property4',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  TestTable5: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  TestTable6: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  JunctionTable: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Model4Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: true,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Model5Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: true,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  TestTableRelation1: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'VARCHAR',
      MaxLength: 255,
      Comment: '',
      DefaultValue: null,
      NativeType: 'VARCHAR',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Property1',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  TestTableRelation2: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'VARCHAR',
      MaxLength: 255,
      Comment: '',
      DefaultValue: null,
      NativeType: 'VARCHAR',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Property2',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'RelId1',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: true,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  RelationRecursive: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'ParentId',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: true,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  ModelNested1: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  ModelNested2: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Nested1Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: true,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  ModelNested3: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Nested2Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: true,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  Discrimination: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'VARCHAR',
      MaxLength: 255,
      Comment: '',
      DefaultValue: null,
      NativeType: 'VARCHAR',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Type',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  MetaTest: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  users_metadata: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'VARCHAR',
      MaxLength: 255,
      Comment: '',
      DefaultValue: null,
      NativeType: 'VARCHAR',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Key',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'TEXT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'TEXT',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'Value',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: true,
      PrimaryKey: false,
      AutoIncrement: false,
      Name: 'UserId',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: true,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  QueryRelationModel: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
  ModelWithScope: [
    {
      Type: 'INT',
      MaxLength: 0,
      Comment: '',
      DefaultValue: null,
      NativeType: 'INT',
      Unsigned: false,
      Nullable: false,
      PrimaryKey: true,
      AutoIncrement: true,
      Name: 'Id',
      Converter: null,
      Schema: 'sqlite',
      Unique: false,
      Uuid: false,
      Ignore: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
      Aggregate: false,
      Virtual: false,
    },
  ],
};

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      db: {
        Connections: [
          {
            Driver: 'sqlite',
            Filename: 'foo.sqlite',
            Name: 'sqlite',
            Migration: {
              OnStartup: false,
            },
          },
          {
            Driver: 'sqlite',
            Filename: 'sample.sqlite',
            Name: 'SampleConnection1',
            Migration: {
              OnStartup: false,
            },
          },
          {
            Driver: 'mysql',
            Database: 'foo',
            User: 'root',
            Password: 'root',
            Host: 'localhost',
            Port: 1234,
            Name: 'main_connection',
            Migration: {
              OnStartup: false,
            },
          },
        ],
      },
    };
  }
}

export class FakeSqliteDriver extends OrmDriver {
  public supportedFeatures() {
    return {
      transactions: true,
      migrations: true,
      tableAlterColumn: true,
      columnComments: true,
      jsonColumn: true,
      upsert: true,
      events: false,
    };
  }

  public async execute(_builder : Builder<any>) : Promise<any[] | any> {
    return false;
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public async tableInfo(table: string, _schema: string): Promise<IColumnDescriptor[]> {
    return TEST_TABLE_INFO[table] || [];
  }

  public transaction(queryOrCallback?: QueryBuilder[] | TransactionCallback): Promise<void> {
    if (queryOrCallback instanceof Function) {
      queryOrCallback(this);
    }

    return;
  }
}

export class FakeMysqlDriver extends OrmDriver {
  public supportedFeatures() {
    return {
      transactions: true,
      migrations: true,
      tableAlterColumn: true,
      columnComments: true,
      jsonColumn: true,
      upsert: true,
      events: false,
    };
  }

  public async execute(_stmt: string | object, _params?: any[]): Promise<any[] | any> {
    return true;
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public async tableInfo(_table: string, _schema: string): Promise<IColumnDescriptor[]> {
    return [];
  }

  public transaction(queryOrCallback?: QueryBuilder[] | TransactionCallback): Promise<void> {
    if (queryOrCallback instanceof Function) {
      queryOrCallback(this);
    }

    return;
  }
}

export class FakeConverter extends ValueConverter {
  public toDB(val: any): any {
    return val;
  }

  public fromDB(val: any): any {
    return val;
  }
}

export class FakeSelectQueryCompiler extends SelectQueryCompiler {
  public compile(): ICompilerOutput {
    return {
      expression: null,
      bindings: null,
    };
  }
}

export class FakeDropTableCompiler extends DropTableCompiler {
  public compile(): ICompilerOutput {
    return {
      expression: null,
      bindings: null,
    };
  }
}

export class FakeDeleteQueryCompiler extends DeleteQueryCompiler {
  public compile(): ICompilerOutput {
    return {
      expression: null,
      bindings: null,
    };
  }
}

export class FakeTableExistsCompiler extends TableExistsCompiler {
  public compile(): ICompilerOutput {
    return {
      expression: null,
      bindings: null,
    };
  }
}

export class FakeInsertQueryCompiler extends InsertQueryCompiler {
  // @ts-ignore
  constructor(private _builder: QueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    return {
      expression: null,
      bindings: null,
    };
  }
}

export class FakeUpdateQueryCompiler extends UpdateQueryCompiler {
  // @ts-ignore
  constructor(private _builder: QueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    return {
      expression: null,
      bindings: null,
    };
  }
}

export class FakeTableQueryCompiler extends TableQueryCompiler {
  // @ts-ignore
  constructor(private _builder: QueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    return {
      expression: null,
      bindings: null,
    };
  }
}

export class FakeColumnQueryCompiler extends ColumnQueryCompiler {
  // @ts-ignore
  constructor(private _builder: QueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    return {
      expression: null,
      bindings: null,
    };
  }
}

export class FakeServerResponseMapper {
  public read(response: any, _pkName?: string): any {
    return {
      LastInsertId: response?.insertId || response?.lastID || 1,
      RowsAffected: response?.changes || response?.affectedRows || 1,
    };
  }
}
