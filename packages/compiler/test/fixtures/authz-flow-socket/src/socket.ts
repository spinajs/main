import { ModelBase, Model, Primary } from '@spinajs/orm';
import { AccessResource } from '@spinajs/authz-orm';
import { BaseSocketController, OnEvent, SocketController } from '@spinajs/http-socket';

@Model('invoices')
@AccessResource('invoice')
export class Invoice extends ModelBase<Invoice> {
  @Primary() public Id: number;
  public Status: string;
}

@SocketController('invoices')
export class InvoiceSocket extends BaseSocketController {
  @OnEvent('opened')
  public async opened(): Promise<void> {
    await Invoice.where('Status', 'open');
  }
}
