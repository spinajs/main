import { ModelBase, Model, Primary } from '@spinajs/orm';
import { AccessResource, Parent } from '@spinajs/authz-orm';

@Model('invoices')
@AccessResource('invoice')
export class Invoice extends ModelBase<Invoice> {
  @Primary() public Id: number;
  @Parent('project') public ProjectId: number;
  public Status: string;
  public DueAt: Date;
}

@Model('notes')
export class Note extends ModelBase<Note> {
  @Primary() public Id: number;
}
