import type { DeleteQueryBuilder, IDeleteQueryBuilder, ISelectQueryBuilder, IUpdateQueryBuilder, InsertQueryBuilder, SelectQueryBuilderC, UpdateQueryBuilder } from '@spinajs/orm';
import { SelectQueryBuilder } from '@spinajs/orm';
import { SYSTEM, authz, type DefaultAuthzService } from '@spinajs/authz';
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
export declare const host: DefaultAuthzService;
export const hostRun = () => host.runAs(SYSTEM, 'vocabulary', async () => 1);
export const scopedEach = () => [
  iSelect.accessible('invoice:read'), iSelect.unscoped('vocabulary'),
  select.accessible('invoice:read'), select.unscoped('vocabulary'),
  iUpdate.accessible('invoice:read'), iUpdate.unscoped('vocabulary'),
  update.accessible('invoice:read'), update.unscoped('vocabulary'),
  iDelete.accessible('invoice:read'), iDelete.unscoped('vocabulary'),
  del.accessible('invoice:read'), del.unscoped('vocabulary'),
];

/** An app's own builder subclass is a select builder through its base. */
export class PagedInvoices extends SelectQueryBuilder<InvoiceModel> {}
export class FixedInvoices extends SelectQueryBuilder<InvoiceModel[]> {}
export class MoreFixedInvoices extends FixedInvoices {}
/** A composed base argument is not mapped through the chain; the model is read from the subclass's own argument. */
export class ListOf<T> extends SelectQueryBuilder<T[]> {}
export declare const listOfInvoices: ListOf<InvoiceModel>;

/** An app's subclass that overrides `clone()`, and an interface that redeclares it. */
export class Paged<T> extends SelectQueryBuilder<T> {
  public override clone(): this {
    return super.clone();
  }
}
export interface ClonedQuery extends ISelectQueryBuilder<InvoiceModel[]> {
  clone(): this;
}

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
  /** As `untypedFirst`, but run as a statement: nothing is returned that could count it. */
  untypedFirstStatement(): void {
    const q = InvoiceModel.where('Status', 'open');
    (q as any).first();
  }
  unconstrained<R>(q: ISelectQueryBuilder<InvoiceModel>) {
    return anything<R>(q);
  }
  async viaOverride(q: Paged<InvoiceModel[]>) {
    q.clone().accessible('invoice:read');
    return await q.all();
  }
  overriddenClone(q: Paged<InvoiceModel[]>) {
    q.clone().accessible('invoice:read');
    return q;
  }
  redeclaredClone(q: ClonedQuery) {
    q.clone().accessible('invoice:read');
    return q;
  }
  withScopes() {
    return InvoiceModel.where('Status', 'open');
  }
}
