import type { Invoice } from './models.js';

export abstract class InvoiceStore {
  public abstract open(): Promise<Invoice[]>;
}

export interface InvoiceReader {
  byStatus(status: string): Promise<Invoice[]>;
}
