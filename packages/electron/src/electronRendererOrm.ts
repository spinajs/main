import { Builder, IColumnDescriptor, ISupportedFeature, ITransactionContext, ITransactionOptions, Orm, OrmDriver, QueryContext } from '@spinajs/orm';
import { Injectable } from '@spinajs/di';

export class RendererOrmDriverBridge extends OrmDriver {
  public supportedFeatures(): ISupportedFeature {
    return {
      events: false,
      insertReturning: false,
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
    return Promise.resolve(this as OrmDriver);
  }
  disconnect(): Promise<OrmDriver> {
    return Promise.resolve(this as OrmDriver);
  }
  tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    return window.ipc.__spinaJsIpcBridge.callOnOrmConnection(this.Options.Name, 'tableInfo', name, schema);
  }

  // Transactions cannot be driven from the renderer: this bridge forwards one statement at a
  // time over IPC and has no connection of its own to hold open. The primitives exist only to
  // satisfy the driver contract; a transaction here is a no-op that still runs its callback,
  // and any transactional work belongs in the main process.
  protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
    return { depth: 0 };
  }

  protected async _commit(_ctx: ITransactionContext): Promise<void> { }

  protected async _rollback(_ctx: ITransactionContext): Promise<void> { }

  protected async _savepoint(_ctx: ITransactionContext, _name: string): Promise<void> { }

  protected async _releaseSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> { }

  protected async _rollbackToSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> { }

  protected async _dispose(_ctx: ITransactionContext): Promise<void> { }
}

@Injectable(Orm)
export class ElectronRendererOrm extends Orm { }
