import type { ISelectQueryBuilder } from '@spinajs/orm';
import { Invoice } from './models.js';

export class Narrowing {
  public narrow(q: ISelectQueryBuilder<Invoice[]>): ISelectQueryBuilder<Invoice[]> {
    return q;
  }
}

export class FreshNarrowing extends Narrowing {
  public override narrow(): ISelectQueryBuilder<Invoice[]> {
    return Invoice.where('Status', 'open');
  }
}

export class HandedShapes {
  public scopedThenHanded(n: Narrowing) {
    return n.narrow(Invoice.where('Status', 'open').accessible('invoice:read'));
  }
}
