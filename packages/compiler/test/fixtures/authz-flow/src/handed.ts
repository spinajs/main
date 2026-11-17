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

export class LocalMaker {
  public make(): Selected {
    return Invoice.query().accessible('invoice:read');
  }
}

export interface UnmadeMaker {
  make(): Selected;
}

export class MakerShapes {
  public local = new LocalMaker();

  public other: UnmadeMaker;

  public picked(c: boolean) {
    const m = c ? this.local : this.other;
    return m.make();
  }

  public external(c: boolean, q: Selected) {
    const m = c ? this.cloner : q;
    return m.clone();
  }

  private cloner = new LocalCloner();
}

export class LocalCloner {
  public clone(): Selected {
    return Invoice.query().accessible('invoice:read');
  }
}

export class ReassignedShapes {
  public reassigned() {
    let q = Invoice.query().accessible('invoice:read');
    q = Invoice.query();
    return q;
  }

  public scopedLater() {
    let q = Invoice.query();
    q = q.accessible('invoice:read');
    return q;
  }

  public clonedScope() {
    const q = Invoice.query();
    q.clone().accessible('invoice:read');
    return q;
  }
}

export class ScopeHelper {
  public accessible(): ScopeHelper {
    return this;
  }

  public builder(): Selected {
    return Invoice.query();
  }
}

export class HelperShapes {
  public chained(h: ScopeHelper) {
    return h.accessible().builder();
  }
}

export class CastShapes {
  public castFromAny(x: any) {
    return x as Selected;
  }

  public castFromUnknown(x: unknown) {
    return x as Selected;
  }

  public castChoiceFromAny(x: any) {
    return (x as Selected) ?? Invoice.query().accessible('invoice:read');
  }
}

export class LogicalAssignShapes {
  public nullishAssigned(c: boolean) {
    let q: Selected | undefined = c ? Invoice.query().accessible('invoice:read') : undefined;
    q ??= Invoice.query();
    return q;
  }

  public orAssigned(c: boolean) {
    let q: Selected | undefined = c ? Invoice.query().accessible('invoice:read') : undefined;
    q ||= Invoice.query();
    return q;
  }
}
