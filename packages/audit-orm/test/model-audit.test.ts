import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, audit } from '@spinajs/audit';
import { Connection, Migration, Model, ModelBase, OrmMigration, Primary } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { AuditTrailTableMigration, auditSubjectType } from '../src/index.js';
import { TestDb } from '../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

@Connection('sqlite')
@Model('audit_invoice')
class AuditInvoice extends ModelBase<AuditInvoice> {
  @Primary()
  public id: string;

  public status: string;
}

@Migration('sqlite')
export class AuditInvoiceTable_2026_11_16_00_00_01 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('audit_invoice', (table) => {
      table.string('id', 64).primaryKey();
      table.string('status', 32);
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('audit_invoice').ifExists();
  }
}

class NoTable extends ModelBase {}

// A model on a connection other than its trails': transactional events land beside it, confirmed ones on the trail's connection.
@Connection('books')
@Model('audit_book')
class AuditBook extends ModelBase<AuditBook> {
  @Primary()
  public id: string;
}

@Migration('books')
export class AuditBookTable_2026_11_16_00_00_02 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('audit_book', (table) => {
      table.string('id', 64).primaryKey();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('audit_book').ifExists();
  }
}

class ReadsTable extends AuditTrailTableMigration {
  protected override table(): string {
    return 'audit_reads';
  }
}

const BOOKS = { Driver: 'orm-driver-sqlite', Name: 'books', Filename: ':memory:', Migration: { OnStartup: true } };
const at = (second: number): Date => new Date(Date.UTC(2026, 10, 16, 10, 0, second));

describe('Model.audit() and row.audit()', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open({ trails: { reads: { table: 'audit_reads', onFailure: 'reject' }, acts: { table: 'audit_acts', onFailure: 'reject' } } }, { connections: [BOOKS] });
    await db.migrate('sqlite', 'audit_reads');
    await db.migrate('sqlite', 'audit_acts');
    const books = db.driver('books');
    await new ReadsTable().up(books);
    await AuditBook.insert({ id: 'b1' });
    const book = { type: 'audit_book', id: 'b1' };
    await audit().record(
      [
        { kind: 'read', action: 'first', subject: book, at: at(1) },
        { kind: 'read', action: 'third', subject: book, at: at(3) },
      ],
      { trail: 'reads', mode: 'confirmed' },
    );
    await books.transaction(() => audit().record({ kind: 'data', action: 'second', subject: book, at: at(2) }, { trail: 'reads', mode: 'transactional', transaction: books }));
    await audit().record({ kind: 'action', action: 'acted', subject: book }, { trail: 'acts', mode: 'confirmed' });
    await AuditInvoice.insert({ id: 'i1', status: 'draft' });
    const about = (id: string) => ({ type: 'audit_invoice', id });
    await audit().record(
      [
        { kind: 'action', action: 'invoice.export', subject: about('i1') },
        { kind: 'action', action: 'invoice.export', subject: about('i2') },
        { kind: 'custom', action: 'unrelated' },
      ],
      { mode: 'confirmed' },
    );
    await audit().record({ kind: 'read', action: 'audit_invoice.read', subject: about('i1') }, { trail: 'reads' });
  });

  after(async () => {
    await db?.close();
  });

  it('lists what happened to one row and to the rows of a model, per trail', async () => {
    expect(auditSubjectType(AuditInvoice)).to.eq('audit_invoice');
    expect((await AuditInvoice.audit().of('i1')).map((e) => e.action)).to.deep.eq(['invoice.export']);
    expect((await AuditInvoice.audit('reads').of('i1')).map((e) => e.kind)).to.deep.eq(['read']);

    const all = await AuditInvoice.audit().since(0);
    expect(all.map((e) => e.subject?.id)).to.deep.eq(['i1', 'i2']);
    expect((await AuditInvoice.audit().since(all[0].seq, { limit: 1 })).map((e) => e.subject?.id)).to.deep.eq(['i2']);
  });

  it('lists what happened to a loaded row', async () => {
    const row = await AuditInvoice.get('i1');
    expect((await row.audit().entries()).map((e) => e.action)).to.deep.eq(['invoice.export']);
    expect((await row.audit('reads').entries({ kinds: ['read'] })).map((e) => e.action)).to.deep.eq(['audit_invoice.read']);
  });

  it("reads a model on another connection there and on the trail's connection, merged by time", async () => {
    const actions = (events: readonly { readonly action: string }[]): string[] => events.map((e) => e.action);
    expect(actions(await AuditBook.audit('reads').of('b1'))).to.deep.eq(['first', 'second', 'third']);
    expect(actions(await AuditBook.audit('reads').of('b1', { limit: 2 }))).to.deep.eq(['first', 'second']);
    expect(actions(await AuditBook.audit('reads').of('b1', { order: 'desc', limit: 2 }))).to.deep.eq(['third', 'second']);
    expect(actions(await (await AuditBook.get('b1')).audit('reads').entries())).to.deep.eq(['first', 'second', 'third']);
    expect(actions(await AuditBook.audit('reads').since(0))).to.deep.eq(['first', 'second', 'third']);

    // An explicit source reads that one connection, and pages it by seq.
    expect(actions(await AuditBook.audit('reads').of('b1', { source: 'books' }))).to.deep.eq(['second']);
    expect(actions(await AuditBook.audit('reads').since(1, { source: 'sqlite' }))).to.deep.eq(['third']);
    await expect(AuditBook.audit('reads').since(1)).to.be.rejectedWith(AuditConfigError, 'audit: afterSeq is a position on one connection, and Model.audit().since reads trail "reads" on "books" and "sqlite"; pass query.source to page one of them');

    // books has no audit_acts: it contributes nothing instead of failing.
    expect(actions(await AuditBook.audit('acts').of('b1'))).to.deep.eq(['acted']);
  });

  it('refuses a row that was never saved, a class without a table and an unknown trail', () => {
    expect(() => new AuditInvoice().audit()).to.throw(AuditConfigError, 'audit: this AuditInvoice has no single primary key value yet, so no event can be about it; save it first');
    expect(() => NoTable.audit()).to.throw(AuditConfigError, 'audit: NoTable is not an ORM model with a table');
    expect(() => AuditInvoice.audit('nope')).to.throw(AuditConfigError, 'audit: no trail named "nope"');
  });
});
