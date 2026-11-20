import type { IDeleteQueryBuilder, ISelectQueryBuilder, IUpdateQueryBuilder } from '@spinajs/orm';
import { Invoice, Note } from './models.js';

type Selected = ISelectQueryBuilder<Invoice[]>;

export class InvoiceSource {
  public make(): ISelectQueryBuilder<Invoice[]> { return Invoice.query(); }
}

export class NoteSource {
  public make(): ISelectQueryBuilder<Note[]> { return Note.query(); }
}

export class VariantShapes {
  public pending?: IUpdateQueryBuilder<Invoice> | IDeleteQueryBuilder<Invoice>;

  public async kinds() { await this.pending; }

  public async models(c: boolean) {
    const q = c ? Invoice.query() : Note.query();
    return q;
  }

  public async sources(c: boolean) { return (c ? new InvoiceSource() : new NoteSource()).make(); }

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

export function ping(n: number): Selected { return n === 0 ? Invoice.query().accessible('invoice:read') : pong(n - 1); }
export function pong(n: number): Selected { return n === 0 ? Invoice.where('Status', 'open') : ping(n - 1); }
export async function rally() { return ping(3); }
export function forever(): Selected { return forever(); }
export async function endless() { return forever(); }

export interface Runner {
  run(q: Selected): Promise<void>;
}

export class IdleRunner {
  public async run(q: Selected): Promise<void> { void q; }
}

export class CallShapes {
  public async handedAside(c: boolean, other: Runner) {
    const runner = c ? new IdleRunner() : other;
    await runner.run(Invoice.query());
  }

  public async picked(c: boolean) { return this.pick(Invoice.query().accessible('invoice:read'), c); }
  public async rootParam(q: Selected) { return q; }
  public async floating() { Invoice.find([1]); }
  public async *streamed() { yield Invoice.query(); }
  public async omitted() { return this.defaulted(); }
  private async defaulted(q: Selected = Invoice.query()) { return q; }

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

export class WrittenShapes {
  public cache?: Selected;

  public async reassigned() {
    let q = Invoice.query();
    q.accessible('invoice:read');
    await q;
    q = Invoice.where('Status', 'open');
    await q;
  }

  public async destructured(list: Selected[]) {
    let q = Invoice.query();
    q.accessible('invoice:read');
    await q;
    [q] = list;
    await q;
  }

  public async untyped(x: any) {
    let q = Invoice.query();
    q.accessible('invoice:read');
    await q;
    q = x;
    await q;
  }

  public async nullish(c: boolean) {
    let q: Selected | undefined = c ? Invoice.query() : undefined;
    q?.accessible('invoice:read');
    q ??= Invoice.where('Status', 'open');
    await q;
  }

  public async cached() { this.cache ??= Invoice.where('Status', 'open'); }
  public async viaAny() { await this.execAny(Invoice.where('Status', 'open')); }
  public async viaGeneric() { await this.execT(Invoice.where('Status', 'open')); }
  public async viaThenable() { await this.execThen(Invoice.where('Status', 'open')); }
  public async passesUnscoped() { await this.withDefault(Invoice.where('Status', 'passed')); }
  private async execAny(q: any) { await q; }
  private async execT<T>(q: T) { await q; }
  private async execThen(q: PromiseLike<unknown>) { await q; }
  private async withDefault(q: Selected = Invoice.query().accessible('invoice:read')) { await q; }
}

export async function c1() { await Invoice.where('Status', 'open'); }
export async function c2() { await c1(); }
export async function c3() { await c2(); }
export async function c4() { await c3(); }
export async function c5() { await c4(); }
export async function c6() { await c5(); }
export async function c7() { await c6(); }
export async function c8() { await c7(); }
export async function c9() { await c8(); }
export async function c10() { await c9(); }
export async function c11() { await c10(); }
export async function c12() { await c11(); }
export async function c13() { await c12(); }
export async function c14() { await c13(); }
export async function c15() { await c14(); }
export async function c16() { await c15(); }
export async function c17() { await c16(); }
export async function c18() { await c17(); }
export async function c19() { await c18(); }
export async function c20() { await c19(); }
export async function c21() { await c20(); }
export async function c22() { await c21(); }
export async function warmChain() { await c1(); await c2(); await c3(); await c4(); await c5(); await c6(); await c7(); await c8(); await c9(); await c10(); await c11(); await c12(); await c13(); await c14(); await c15(); await c16(); await c17(); await c18(); await c19(); await c20(); await c21(); await c22(); }
export async function lastOnly() { await c22(); }

export class PassedByName {
  public async forEachByName() {
    [Invoice.where('Status', 'each')].forEach(this.exec);
  }

  public async mappedByName(queries: Selected[]) {
    await Promise.all(queries.map(this.exec));
  }

  public async madeByName(statuses: string[]) {
    await Promise.all(statuses.map(this.make));
  }

  public async withThis() {
    await this.execWithThis(Invoice.query().accessible('invoice:read'), Invoice.where('Status', 'this2'));
  }

  public async redeclared() {
    var q = Invoice.query();
    q.accessible('invoice:read');
    await q;
    var q = Invoice.where('Status', 'var2');
    await q;
  }

  private exec = async (q: Selected) => {
    await q;
  };

  private make = (status: string) => Invoice.where('Status', status);

  private async execWithThis(this: PassedByName, scoped: Selected, q: Selected) {
    void scoped;
    await q;
  }
}
