import { Injectable } from '@spinajs/di';
import { Invoice } from './models.js';
import { InvoiceStore } from './stores.js';
import type { InvoiceReader } from './stores.js';

@Injectable(InvoiceStore)
export class DbInvoiceStore extends InvoiceStore {
  public async open(): Promise<Invoice[]> {
    return Invoice.where('Status', 'open');
  }
}

export class SqlInvoiceReader implements InvoiceReader {
  public async byStatus(status: string): Promise<Invoice[]> {
    return Invoice.where('Status', status).accessible('invoice:read');
  }
}
