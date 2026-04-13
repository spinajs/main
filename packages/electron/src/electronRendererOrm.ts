import { Builder, IColumnDescriptor, ISupportedFeature, ITransaction, Orm, OrmDriver, QueryBuilder, QueryContext, TransactionCallback } from '@spinajs/orm';
import { Injectable } from '@spinajs/di';

export class RendererOrmDriverBridge extends OrmDriver {
  public supportedFeatures(): ISupportedFeature {
    return {
      events: false,
    };
  }

  execute(_builder: Builder<any>): Promise<any> {
    return Promise.resolve(this);
  }
  executeOnDb(stmt: string | object, params: any[], context: QueryContext): Promise<any> {
    return window.ipc.__spinaJsIpcBridge.callOnOrmConnection(this.Options.Name, 'executeOnDb', stmt, params, context);
  }
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
  connect(): Promise<OrmDriver> {
    return Promise.resolve(this);
  }
  disconnect(): Promise<OrmDriver> {
    return Promise.resolve(this);
  }
  tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    return window.ipc.__spinaJsIpcBridge.callOnOrmConnection(this.Options.Name, 'tableInfo', name, schema);
  }
  
  async transaction(_queryOrCallback?: QueryBuilder<any>[] | TransactionCallback): Promise<ITransaction> {
    return {
      commit: async () => { },
      rollback: async () => { }
    }
  }
}

@Injectable(Orm)
export class ElectronRendererOrm extends Orm { }
