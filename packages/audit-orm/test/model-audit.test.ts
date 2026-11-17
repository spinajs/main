import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, audit } from '@spinajs/audit';
import { Connection, Migration, Model, ModelBase, OrmMigration, Primary } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { auditSubjectType } from '../src/index.js';
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

describe('Model.audit() and row.audit()', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open({ trails: { reads: { table: 'audit_reads', onFailure: 'reject' } } });
    await db.migrate('sqlite', 'audit_reads');
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

  it('refuses a row that was never saved, a class without a table and an unknown trail', () => {
    expect(() => new AuditInvoice().audit()).to.throw(AuditConfigError, 'audit: this AuditInvoice has no single primary key value yet, so no event can be about it; save it first');
    expect(() => NoTable.audit()).to.throw(AuditConfigError, 'audit: NoTable is not an ORM model with a table');
    expect(() => AuditInvoice.audit('nope')).to.throw(AuditConfigError, 'audit: no trail named "nope"');
  });
});
