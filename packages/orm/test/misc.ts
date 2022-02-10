import { ValueConverter } from './../src/interfaces';
import { join, normalize, resolve } from 'path';
import { IColumnDescriptor, ColumnQueryCompiler, SelectQueryCompiler, ICompilerOutput, DeleteQueryCompiler, InsertQueryCompiler, UpdateQueryCompiler, TableQueryCompiler, QueryBuilder } from '../src';
import { IContainer } from '@spinajs/di';
import { OrmDriver, TransactionCallback } from "./../src/driver";
import { Configuration } from '@spinajs/configuration';
import _ from 'lodash';

export function dir(path: string) {
    return resolve(normalize(join(__dirname, path)));
}

export class ConnectionConf extends Configuration {
 
    protected conf = {
        log: {
            name: 'spine-framework',
            /**
             * streams to log to. See more on bunyan docs
             */
            streams: null as any
        },
        system: {
            dirs: {
                migrations: [dir("./mocks/migrations")],
                models: [dir("./mocks/models")],

            }
        },
        db: {
            Migration:{
                Startup: false,
            },
            Connections: [
                {
                    Driver: "sqlite",
                    Filename: "foo.sqlite",
                    Name: "sqlite"
                },
                {
                    Driver: "mysql",
                    Database: "foo",
                    User: "root",
                    Password: "root",
                    Host: "localhost",
                    Port: 1234,
                    Name: "main_connection"
                }
            ]
        }
    }

    // tslint:disable-next-line: no-empty
    public resolve(_container: IContainer): void {
         
    }


    public get(path: string[], defaultValue?: any): any {
        return _.get(this.conf, path, defaultValue);
    }
}



// @ts-ignore
export class FakeSqliteDriver extends OrmDriver {

    public async execute(_stmt: string | object, _params?: any[]): Promise<any[] | any> {
        return true;
    }

    // tslint:disable-next-line: no-empty
    public async ping(): Promise<boolean> {
        return true;
    }

    // tslint:disable-next-line: no-empty
    public async connect(): Promise<OrmDriver> {
        return this;
    }

    // tslint:disable-next-line: no-empty
    public async disconnect(): Promise<OrmDriver> {
        return this;
    }

    public async tableInfo(_table: string, _schema: string): Promise<IColumnDescriptor[]> {
        return null;
    }

    // tslint:disable-next-line: no-empty
    public resolve(_container: IContainer): void {
        this.Container = _container;
    }

    public transaction(queryOrCallback?: QueryBuilder[] | TransactionCallback): Promise<void> {

        if(queryOrCallback instanceof Function){
            queryOrCallback(this);
        }
        
        return;
    }
}

export class FakeMysqlDriver extends OrmDriver {

    public async execute(_stmt: string | object, _params?: any[]): Promise<any[] | any> {
        return true;
    }

    // tslint:disable-next-line: no-empty
    public async ping(): Promise<boolean> {
        return true;
    }

    // tslint:disable-next-line: no-empty
    public async connect(): Promise<OrmDriver> {
        return this;

    }

    // tslint:disable-next-line: no-empty
    public async disconnect(): Promise<OrmDriver> {
        return this;
    }

    public async tableInfo(_table: string, _schema: string): Promise<IColumnDescriptor[]> {
        return null;
    }

    // tslint:disable-next-line: no-empty
    public resolve(container: IContainer): void {
        this.Container = container;
    }

    public transaction(queryOrCallback?: QueryBuilder[] | TransactionCallback): Promise<void> {
        
        if(queryOrCallback instanceof Function){
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
            bindings: null
        };
    }

}

export class FakeDeleteQueryCompiler extends DeleteQueryCompiler {

    public compile(): ICompilerOutput {
        return {
            expression: null,
            bindings: null
        };
    }

}

export class FakeInsertQueryCompiler extends InsertQueryCompiler {

    // @ts-ignore
    constructor(private _builder: QueryBuilder) {
        super()
    }


    public compile(): ICompilerOutput {
        return {
            expression: null,
            bindings: null
        };
    }

}

export class FakeUpdateQueryCompiler extends UpdateQueryCompiler {

    // @ts-ignore
    constructor(private _builder: QueryBuilder) {
        super()
    }

    public compile(): ICompilerOutput {
        return {
            expression: null,
            bindings: null
        };
    }

}


export class FakeTableQueryCompiler extends TableQueryCompiler {

    // @ts-ignore
    constructor(private _builder: QueryBuilder) {
        super()
    }

    public compile(): ICompilerOutput {
        return {
            expression: null,
            bindings: null
        };
    }
}

export class FakeColumnQueryCompiler extends ColumnQueryCompiler {

    // @ts-ignore
    constructor(private _builder: QueryBuilder) {
        super()
    }

    public compile(): ICompilerOutput {
        return {
            expression: null,
            bindings: null
        };
    }

}