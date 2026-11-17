import type { IDeleteQueryBuilder, ISelectQueryBuilder, IUpdateQueryBuilder } from '@spinajs/orm';
import { Invoice, Note } from './models.js';

type Selected = ISelectQueryBuilder<Invoice[]>;

export class InvoiceSource {
  public make(): ISelectQueryBuilder<Invoice[]> {
    return Invoice.query();
  }
}

export class NoteSource {
  public make(): ISelectQueryBuilder<Note[]> {
    return Note.query();
  }
}

export class VariantShapes {
  public pending?: IUpdateQueryBuilder<Invoice> | IDeleteQueryBuilder<Invoice>;

  public async kinds() {
    await this.pending;
  }

  public async models(c: boolean) {
    const q = c ? Invoice.query() : Note.query();
    return q;
  }

  public async sources(c: boolean) {
    return (c ? new InvoiceSource() : new NoteSource()).make();
  }

  public async reassigned(c: boolean) {
    let q: Selected | ISelectQueryBuilder<Note[]> = Invoice.query().accessible('invoice:read');
    if (c) q = Note.query();
    return q;
  }
}

export class LoopShapes {
  public async reassignedLater(rounds: number) {
    let q = Invoice.query().accessible('invoice:read');
    for (let i = 0; i < rounds; i++) {
      await q;
      q = Invoice.query();
    }
  }

  public async carried(rounds: number) {
    let a = Invoice.query().accessible('invoice:read');
    let b = Invoice.query().accessible('invoice:read');
    for (let i = 0; i < rounds; i++) {
      await a;
      a = b;
      b = Invoice.where('Status', 'open');
    }
  }

  public async narrowed(statuses: string[]) {
    let q = Invoice.query().accessible('invoice:read');
    for (const status of statuses) q = q.where('Status', status);
    return q;
  }

  public async reused(list: Selected[]) {
    let q = Invoice.query().accessible('invoice:read');
    for (q of list) await q;
  }

  public async deferred() {
    let q = Invoice.query().accessible('invoice:read');
    setTimeout(async () => {
      await q;
    }, 0);
    q = Invoice.query();
  }
}

export function ping(n: number): Selected {
  return n === 0 ? Invoice.query().accessible('invoice:read') : pong(n - 1);
}

export function pong(n: number): Selected {
  return n === 0 ? Invoice.where('Status', 'open') : ping(n - 1);
}

export async function rally() {
  return ping(3);
}

export function forever(): Selected {
  return forever();
}

export async function endless() {
  return forever();
}

export interface Runner {
  run(q: Selected): Promise<void>;
}

export class IdleRunner {
  public async run(q: Selected): Promise<void> {
    void q;
  }
}

export class CallShapes {
  public async handedAside(c: boolean, other: Runner) {
    const runner = c ? new IdleRunner() : other;
    await runner.run(Invoice.query());
  }

  public async picked(c: boolean) {
    return this.pick(Invoice.query().accessible('invoice:read'), c);
  }

  public async rootParam(q: Selected) {
    return q;
  }

  public async floating() {
    Invoice.find([1]);
  }

  public async *streamed() {
    yield Invoice.query();
  }

  public async omitted() {
    return this.defaulted();
  }

  private async defaulted(q: Selected = Invoice.query()) {
    return q;
  }

  private pick(q: Selected, c: boolean) {
    let r = q;
    if (c) r = Invoice.query();
    return r;
  }
}

export class LateShapes {
  public async rowsThenBuilder() {
    let x: unknown = await Invoice.query().accessible('invoice:read');
    x = Invoice.query();
    await x;
  }

  public async scopedInCallback() {
    const q = Invoice.query();
    setTimeout(() => {
      q.accessible('invoice:read');
    }, 0);
    return q;
  }
}
