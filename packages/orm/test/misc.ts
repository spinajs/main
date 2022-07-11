/* eslint-disable prettier/prettier */
import { ValueConverter } from './../src/interfaces';
import { join, normalize, resolve } from 'path';
import { IColumnDescriptor, ColumnQueryCompiler, DropTableCompiler, TableExistsCompiler, SelectQueryCompiler, ICompilerOutput, DeleteQueryCompiler, InsertQueryCompiler, UpdateQueryCompiler, TableQueryCompiler, QueryBuilder } from '../src';
import { OrmDriver, TransactionCallback } from './../src/driver';
import { FrameworkConfiguration } from '@spinajs/configuration';
import * as _ from 'lodash';

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolveAsync(): Promise<void> {
    await super.resolveAsync();

    this.Config = {
      system: {
        dirs: {
          migrations: [dir('./mocks/migrations')],
          models: [dir('./mocks/models')],
        },
      },
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
  public async execute(_stmt: string | object, _params?: any[]): Promise<any[] | any> {
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

  public async tableInfo(_table: string, _schema: string): Promise<IColumnDescriptor[]> {
    return null;
  }

  public transaction(queryOrCallback?: QueryBuilder[] | TransactionCallback): Promise<void> {
    if (queryOrCallback instanceof Function) {
      queryOrCallback(this);
    }

    return;
  }
}

export class FakeMysqlDriver extends OrmDriver {
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
    return null;
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
