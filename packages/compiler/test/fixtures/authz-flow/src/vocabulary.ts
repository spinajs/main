import type { DeleteQueryBuilder, IDeleteQueryBuilder, ISelectQueryBuilder, IUpdateQueryBuilder, InsertQueryBuilder, SelectQueryBuilderC, UpdateQueryBuilder } from '@spinajs/orm';
import { SelectQueryBuilder } from '@spinajs/orm';
import { SYSTEM, authz } from '@spinajs/authz';
import type { Invoice } from './models.js';
import { Invoice as InvoiceModel } from './models.js';

export declare const iSelect: ISelectQueryBuilder<Invoice>;
export declare const select: SelectQueryBuilder<Invoice>;
export declare const selectC: SelectQueryBuilderC<Invoice>;
export declare const iUpdate: IUpdateQueryBuilder<Invoice>;
export declare const update: UpdateQueryBuilder<Invoice>;
export declare const iDelete: IDeleteQueryBuilder<Invoice>;
export declare const del: DeleteQueryBuilder<Invoice>;
export declare const insert: InsertQueryBuilder;

export const scoped = (q: ISelectQueryBuilder<Invoice>) => q.accessible('invoice:read').unscoped('vocabulary');
export const copied = (q: ISelectQueryBuilder<Invoice>, c: SelectQueryBuilder<Invoice>) => [q.clone(), c.clone()];
export const systemRun = () => authz().runAs(SYSTEM, 'vocabulary', async () => 1);

/** An app's own builder subclass is a select builder through its base. */
export class PagedInvoices extends SelectQueryBuilder<InvoiceModel> {}

/** An app's own `accessible()` scopes nothing: it is not the authz-orm member. */
export interface LooseQuery extends ISelectQueryBuilder<InvoiceModel> {
  accessible(note: string): this;
}

/** A narrowing result that stays an open conditional type inside a generic function. */
type Keep<B, A extends string> = string extends A ? B : B & { readonly alias: A };
declare function keep<B extends ISelectQueryBuilder<InvoiceModel>, A extends string>(q: B, as: A): Keep<B, A>;

/** Results that may be a builder or rows, or rows now or later. */
declare function builderOrRows(q: ISelectQueryBuilder<InvoiceModel>): ISelectQueryBuilder<InvoiceModel> | Promise<InvoiceModel[]>;
declare function rowsMaybeLater(q: ISelectQueryBuilder<InvoiceModel>): Promise<InvoiceModel[]> | InvoiceModel[];
/** A result the type says nothing about. */
declare function anything<R>(q: ISelectQueryBuilder<InvoiceModel>): R;

/** Reached from no entry point, so it adds no effect to any whole-fixture expectation. */
export class Vocabulary {
  async streamed(q: ISelectQueryBuilder<InvoiceModel>): Promise<number> {
    let n = 0;
    for await (const row of q.stream()) n += row ? 1 : 0;
    return n;
  }
  paged(q: ISelectQueryBuilder<InvoiceModel>) {
    return q.paginate({ limit: 10, orderBy: [['Id', 'asc']] });
  }
  chained(q: ISelectQueryBuilder<InvoiceModel>) {
    return q.where('Status', 'open').count();
  }
  thenned(q: ISelectQueryBuilder<InvoiceModel>) {
    return q.then((rows) => rows);
  }
  untyped(q: ISelectQueryBuilder<InvoiceModel>) {
    return (q as any).first();
  }
  open<B extends ISelectQueryBuilder<InvoiceModel>, A extends string>(q: B, as: A) {
    return keep(q, as);
  }
  loose(q: LooseQuery) {
    return q.accessible('note');
  }
  scopedHere(q: ISelectQueryBuilder<InvoiceModel>) {
    return q.accessible('invoice:read');
  }
  copiedHere(q: ISelectQueryBuilder<InvoiceModel>) {
    return q.clone();
  }
  mixed(q: ISelectQueryBuilder<InvoiceModel>) {
    return builderOrRows(q);
  }
  maybeLater(q: ISelectQueryBuilder<InvoiceModel>) {
    return rowsMaybeLater(q);
  }
  /** `stream()` was not in the member list. */
  async streamAll(): Promise<number> {
    let n = 0;
    for await (const row of InvoiceModel.where('Status', 'open').stream()) n += row ? 1 : 0;
    return n;
  }
  /** The receiver is typed `any`; the traced value is still the builder. */
  untypedFirst(): Promise<unknown> {
    const q = InvoiceModel.where('Status', 'open');
    return (q as any).first();
  }
  unconstrained<R>(q: ISelectQueryBuilder<InvoiceModel>) {
    return anything<R>(q);
  }
  withScopes() {
    return InvoiceModel.where('Status', 'open');
  }
}
