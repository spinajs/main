import { Autoinject, DI } from '@spinajs/di';
import type { ISelectQueryBuilder } from '@spinajs/orm';
import { SYSTEM, authz } from '@spinajs/authz';
import { Invoice } from './models.js';
import { InvoiceStore } from './stores.js';
import type { InvoiceReader } from './stores.js';

export class InvoiceService {
  @Autoinject(InvoiceStore)
  protected Store: InvoiceStore;

  public async overdue(days: number) {
    const q = Invoice.where('Status', 'open');
    return this.withAge(q, days);
  }

  public async listed() {
    return Invoice.where('Status', 'open').accessible('invoice:read');
  }

  public async stored() {
    return this.Store.open();
  }

  public async archive() {
    await Invoice.update({ Status: 'archived' }).where('Status', 'closed');
  }

  public async purge(reason: string) {
    return authz().runAs(SYSTEM, reason, async () => Invoice.destroy().where('Status', 'void'));
  }

  public async nightly() {
    return authz().runAs(SYSTEM, 'nightly export', async () => Invoice.all());
  }

  public async both() {
    return Promise.all([Invoice.where('Status', 'open'), Invoice.where('Status', 'paid').accessible('invoice:read')]);
  }

  public async ran() {
    return this.run(Invoice.where('Status', 'draft'));
  }

  public async each(visit: (invoice: Invoice) => Promise<void>) {
    for (const invoice of await Invoice.where('Status', 'open').accessible('invoice:read')) await visit(invoice);
  }

  public async sweep(ids: number[]) {
    await Promise.all(ids.map(this.remove));
  }

  private remove = async (id: number) => Invoice.destroy(id);

  private withAge(q: ISelectQueryBuilder<Invoice[]>, days: number) {
    return q.where('DueAt', '<', new Date(Date.now() - days * 86_400_000));
  }

  private async run(q: ISelectQueryBuilder<Invoice[]>) {
    return q;
  }
}

export class ReportService {
  public async rows(): Promise<Invoice[]> {
    return Invoice.where('Status', 'paid').accessible('invoice:read');
  }
}

export class LegacyReportService extends ReportService {
  public override async rows(): Promise<Invoice[]> {
    return Invoice.where('Status', 'paid');
  }
}

export function resolvedOverdue() {
  return DI.resolve(InvoiceService).overdue(3);
}

export async function report(reader: InvoiceReader) {
  return reader.byStatus('open');
}

export async function walk(depth: number): Promise<Invoice[]> {
  if (depth === 0) return Invoice.where('Status', 'open');
  return climb(depth);
}

export async function climb(depth: number): Promise<Invoice[]> {
  return walk(depth - 1);
}
