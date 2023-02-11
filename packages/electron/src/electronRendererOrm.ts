import { IColumnDescriptor, Orm, QueryBuilder, QueryContext, TransactionCallback } from "@spinajs/orm";
import { SqlDriver } from "@spinajs/orm-sql";
import { Injectable } from "@spinajs/di";

@Injectable(SqlDriver)
export class RendererOrmDriverBridge extends SqlDriver {
    execute(stmt: string | object, params: any[], context: QueryContext): Promise<any> {
        return window.ipc.__spinaJsIpcBridge.callOnOrmConnection(this.Options.Name, "execute", stmt, params, context);

    }
    ping(): Promise<boolean> {
        return Promise.resolve(true);
    }
    connect(): Promise<SqlDriver> {
        return Promise.resolve(this);

    }
    disconnect(): Promise<SqlDriver> {
        return Promise.resolve(this);

    }
    tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
        return window.ipc.__spinaJsIpcBridge.callOnOrmConnection(this.Options.Name, "tableInfo", name, schema);

    }
    transaction(_queryOrCallback?: QueryBuilder<any>[] | TransactionCallback): Promise<void> {
        return Promise.resolve();
    }

}

@Injectable(Orm)
export class ElectronRendererOrm extends Orm {

}