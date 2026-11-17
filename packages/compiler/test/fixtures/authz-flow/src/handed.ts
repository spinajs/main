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

type Selected = ISelectQueryBuilder<Invoice[]>;

export class OptionalShapes {
  public maybe?: Selected;

  public nullishOptional(q?: Selected) {
    return q ?? Invoice.query().accessible('invoice:read');
  }

  public orUnion(q: Selected | undefined) {
    return q || Invoice.query().accessible('invoice:read');
  }

  public anyOperand(x: any) {
    return x ?? Invoice.query().accessible('invoice:read');
  }

  public optionalParam(q?: Selected) {
    return q;
  }

  public asserted(q: Selected | undefined) {
    return q!;
  }

  public generic<B extends Selected>(q: B) {
    return q;
  }

  public fromMap(m: Map<string, Selected>) {
    return m.get('a')!;
  }

  public field() {
    return this.maybe!;
  }
}
