import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { JobModel } from '@spinajs/queue';
import { BillingRecord } from '../vendor/billing-lib/index.js';
import { Tenant, registerTenantModel } from '../vendor/tenancy-orm/index.js';

@Tenant({ isolation: 'schema', column: false })
export abstract class Placed<T> extends ModelBase<T> {
  @Primary() public Id: number;
}

@Model('ledgers')
export class Ledger extends Placed<Ledger> {}

@Connection('default')
@Model('invoices')
@Tenant()
export class Invoice extends ModelBase<Invoice> {
  @Primary() public Id: number;
  public tenant_id: string;
}

@Model('payments')
@Tenant({ column: 'org_id', rls: true })
export class Payment extends ModelBase<Payment> {
  @Primary() public Id: number;
  public org_id: string;
}

@Model('countries')
export class Country extends ModelBase<Country> {
  @Primary() public Id: number;
}

@Model('audits')
export class Audit extends ModelBase<Audit> {
  @Primary() public Id: number;
  public tenant_id: string;
}

@Model('receipts')
export class Receipt extends BillingRecord<Receipt> {}

registerTenantModel(Audit, { isolation: 'row' });
registerTenantModel(JobModel);
