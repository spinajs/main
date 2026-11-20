import type { ISelectQueryBuilder } from '@spinajs/orm';
import { Invoice } from './models.js';

export class GapService {
  public async chosen(all: boolean) {
    return this.run(all ? Invoice.query() : Invoice.where('Status', 'open').accessible('invoice:read'));
  }

  public async either(all: boolean) {
    const q = all ? Invoice.query() : Invoice.where('Status', 'open').accessible('invoice:read');
    return q;
  }

  public async visitAll(ids: number[], visit: (id: number) => Promise<void>) {
    await Promise.all(ids.map(visit));
  }

  public async bound(id: number) {
    return this.remove.call(this, id);
  }

  public handedOut() {
    return Invoice.where('Status', 'late');
  }

  public async scopedLater() {
    return this.handedOut().accessible('invoice:read');
  }

  public async added() {
    await Invoice.insert({ Status: 'new' });
    return Invoice.exists();
  }

  private remove = async (id: number) => Invoice.destroy(id);

  private async run(q: ISelectQueryBuilder<Invoice[]>) {
    return q;
  }
}
