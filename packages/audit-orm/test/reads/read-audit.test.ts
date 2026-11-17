import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { AuditConfigError, AuditStore, AuditWriteFailed, audit } from '@spinajs/audit';
import { MemoryAuditStore } from '@spinajs/audit/testing';
import { BelongsTo, Connection, Model, ModelBase, Orm, Primary, QueryMiddleware, SortOrder, extractModelDescriptor } from '@spinajs/orm';
import type { SingleRelation } from '@spinajs/orm';

import { AuditReads, ReadAuditMiddleware, registerAuditReads } from '../../src/index.js';
import { DIALECTS, TestDb } from '../../src/testing.js';
import type { Dialect } from '../../src/testing.js';
import { TestAuditStore, recorded, resetTrail } from '../support/trail.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

class PatientColumns<M> extends ModelBase<M> {
  @Primary()
  public Id: number;

  public Name: string;

  public Ssn: string;

  public Ward: number;
}

class VisitColumns<M> extends ModelBase<M> {
  @Primary()
  public Id: number;

  public Reason: string;

  public patient_id: number;
}

const RESTRICTED = { trail: 'restricted', columns: ['Ssn'] } as const;
const SEARCH_TABLE = 'audit_read';
const searches = (dialect: Dialect): string => `searches_${dialect}`;
const searchRule = (dialect: Dialect) => ({ trail: searches(dialect), mode: 'query', onFailure: 'continue' } as const);

// One pair per dialect: a model is bound to one connection, and the ORM finds models by class name.
@Connection('sqlite')
@Model('patient')
@AuditReads(RESTRICTED)
class Patient extends PatientColumns<Patient> {}

@Connection('sqlite')
@Model('visit')
@AuditReads(searchRule('sqlite'))
class Visit extends VisitColumns<Visit> {
  @BelongsTo(Patient, 'patient_id', 'Id')
  public Patient: SingleRelation<Patient>;
}

@Connection('pglite')
@Model('patient')
@AuditReads(RESTRICTED)
class PglitePatient extends PatientColumns<PglitePatient> {}

@Connection('pglite')
@Model('visit')
@AuditReads(searchRule('pglite'))
class PgliteVisit extends VisitColumns<PgliteVisit> {
  @BelongsTo(PglitePatient, 'patient_id', 'Id')
  public Patient: SingleRelation<PglitePatient>;
}

@Connection('postgres')
@Model('patient')
@AuditReads(RESTRICTED)
class PostgresPatient extends PatientColumns<PostgresPatient> {}

@Connection('postgres')
@Model('visit')
@AuditReads(searchRule('postgres'))
class PostgresVisit extends VisitColumns<PostgresVisit> {
  @BelongsTo(PostgresPatient, 'patient_id', 'Id')
  public Patient: SingleRelation<PostgresPatient>;
}

@Connection('mysql')
@Model('patient')
@AuditReads(RESTRICTED)
class MysqlPatient extends PatientColumns<MysqlPatient> {}

@Connection('mysql')
@Model('visit')
@AuditReads(searchRule('mysql'))
class MysqlVisit extends VisitColumns<MysqlVisit> {
  @BelongsTo(MysqlPatient, 'patient_id', 'Id')
  public Patient: SingleRelation<MysqlPatient>;
}

interface Models {
  readonly Patient: typeof Patient;
  readonly Visit: typeof Visit;
}

const MODELS: Record<Dialect, Models> = {
  sqlite: { Patient, Visit },
  pglite: { Patient: PglitePatient, Visit: PgliteVisit },
  postgres: { Patient: PostgresPatient, Visit: PostgresVisit },
  mysql: { Patient: MysqlPatient, Visit: MysqlVisit },
};

class Keyless extends ModelBase<Keyless> {
  public Name: string;
}

const RETRY = { attempts: 2, delay: '1ms' };
const AUDIT = {
  trails: {
    restricted: { store: 'TestAuditStore', onFailure: 'reject', retry: RETRY },
    ...Object.fromEntries(DIALECTS.map((d) => [searches(d), { connection: d, table: SEARCH_TABLE, retry: RETRY }])),
  },
};

async function seed(db: TestDb, dialect: Dialect, models: Models): Promise<void> {
  const schema = db.driver(dialect).schema();
  await schema.dropTable('visit').ifExists();
  await schema.dropTable('patient').ifExists();
  await schema.createTable('patient', (table) => {
    table.int('Id').primaryKey().autoIncrement();
    table.string('Name');
    table.string('Ssn');
    table.int('Ward');
  });
  await schema.createTable('visit', (table) => {
    table.int('Id').primaryKey().autoIncrement();
    table.string('Reason');
    table.int('patient_id');
  });
  await (await DI.resolve(Orm)).reloadTableInfo({ models: [models.Patient, models.Visit] });

  await models.Patient.insert({ Name: 'Ada', Ssn: '111', Ward: 4 });
  await models.Patient.insert({ Name: 'Bo', Ssn: '222', Ward: 4 });
  await models.Patient.insert({ Name: 'Cy', Ssn: '333', Ward: 5 });
  await models.Visit.insert({ Reason: 'checkup', patient_id: 1 });
  await models.Visit.insert({ Reason: 'follow-up', patient_id: 1 });
  await models.Visit.insert({ Reason: 'x-ray', patient_id: 2 });
}

describe('read auditing', function () {
  this.timeout(60000);

  let db: TestDb;

  before(async () => {
    DI.register(TestAuditStore).as(AuditStore);
    db = await TestDb.open(AUDIT);
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(resetTrail);

  it('is a query middleware at order 200', () => {
    expect(DI.getRegisteredTypes(QueryMiddleware)).to.include(ReadAuditMiddleware);
    expect(new ReadAuditMiddleware().order).to.eq(200);
  });

  it('refuses a rule it cannot apply', () => {
    expect(() => registerAuditReads(Patient, { mode: 'sometimes' as never })).to.throw(AuditConfigError, "@AuditReads on Patient: mode must be 'row' or 'query', got sometimes");
    expect(() => registerAuditReads(Patient, { onFailure: 'ignore' as never })).to.throw(AuditConfigError, "@AuditReads on Patient: onFailure must be 'continue' or 'reject', got ignore");
    expect(() => registerAuditReads(Patient, { columns: [] })).to.throw(AuditConfigError, '@AuditReads on Patient: columns must name at least one column');
  });

  it('refuses row mode on a model without a primary key, where the rule is declared', () => {
    expect(() => registerAuditReads(Keyless)).to.throw(AuditConfigError, "@AuditReads on Keyless: mode 'row' needs a primary key, and Keyless declares none; use mode 'query'");
    expect(() => registerAuditReads(Keyless, { mode: 'query' })).to.not.throw();
  });

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      const { Patient, Visit } = MODELS[dialect];
      const searched = () => audit().trail(searches(dialect)).since(0);

      before(async function () {
        if (!db.has(dialect)) this.skip();
        await seed(db, dialect, MODELS[dialect]);
      });

      beforeEach(async () => {
        await db.migrate(dialect, SEARCH_TABLE);
      });

      after(async () => {
        if (!db.has(dialect)) return;
        await db.drop(dialect, SEARCH_TABLE);
        await db.driver(dialect).schema().dropTable('visit').ifExists();
        await db.driver(dialect).schema().dropTable('patient').ifExists();
      });

      it('records one event per returned row', async () => {
        const rows = await Patient.query().where('Ward', 4);

        expect(rows).to.have.length(2);
        const events = await recorded('restricted');
        expect(events.map((e) => [e.kind, e.action, e.outcome, e.subject, e.data])).to.deep.eq([
          ['read', 'patient.read', 'ok', { type: 'patient', id: '1' }, { columns: ['Ssn'] }],
          ['read', 'patient.read', 'ok', { type: 'patient', id: '2' }, { columns: ['Ssn'] }],
        ]);
      });

      it("names a row by its model's table", async () => {
        await Patient.query().where('Id', 1);

        const [event] = await recorded('restricted');
        expect(event.subject).to.deep.eq({ type: extractModelDescriptor(Patient)?.TableName, id: '1' });
      });

      it('skips a select that returns none of the audited columns', async () => {
        await Patient.query().columns(['Id', 'Name']);
        expect(await Patient.query().selectCount()).to.eq(3);

        expect(await recorded('restricted')).to.deep.eq([]);
      });

      it('audits a raw select like a hydrated one', async () => {
        const rows = await Patient.query().where('Id', 1).asRaw<Record<string, unknown>[]>();

        expect(rows[0].Ssn).to.eq('111');
        expect((await recorded('restricted')).map((e) => e.subject?.id)).to.deep.eq(['1']);
      });

      it('records one statement event when the rows carry no primary key', async () => {
        await Patient.query().columns(['Ssn']).asRaw();

        const events = await recorded('restricted');
        expect(events).to.have.length(1);
        expect(events[0].subject).to.eq(undefined);
        expect(events[0].data).to.deep.eq({ columns: ['Ssn'], rows: 3, filter: [], keyless: true });
      });

      it('query mode records one event per statement with the filter columns, never their values', async () => {
        await Visit.query().where('Reason', 'checkup');

        const events = await searched();
        expect(events).to.have.length(1);
        expect(events[0].action).to.eq('visit.read');
        expect(events[0].subject).to.eq(undefined);
        const data = events[0].data as { columns: string[]; rows: number; filter: { column?: string }[] };
        expect(data.columns).to.deep.eq(['*']);
        expect(data.rows).to.eq(1);
        expect(data.filter.map((f) => f.column)).to.deep.eq(['Reason']);
        expect(JSON.stringify(events[0])).to.not.contain('checkup');
      });

      it('audits the columns a belongsTo populate joins in, once per related row', async () => {
        await Visit.query().populate('Patient');

        const events = await recorded('restricted');
        expect(events.map((e) => e.subject?.id).sort()).to.deep.eq(['1', '2']);
        expect(events.map((e) => e.subject?.type)).to.deep.eq(['patient', 'patient']);
        expect(events[0].data).to.deep.eq({ columns: ['Ssn'] });
      });

      it('records a streamed select batch by batch, before the batch is yielded', async () => {
        const seen: number[] = [];
        for await (const patient of Patient.query().order('Id', SortOrder.ASC).stream({ batchSize: 2 })) {
          if (seen.length === 0) {
            expect(await recorded('restricted')).to.have.length(2);
          }
          seen.push(patient.Id);
        }

        expect(seen).to.deep.eq([1, 2, 3]);
        expect(await recorded('restricted')).to.have.length(3);
      });

      it('rejects the select when the record cannot be written, after the retries', async () => {
        MemoryAuditStore.failNext(2);

        await expect(Patient.query().where('Ward', 4).all()).to.be.rejectedWith(AuditWriteFailed);

        expect(TestAuditStore.calls).to.eq(2);
        expect(await recorded('restricted')).to.deep.eq([]);
      });

      it('returns the rows when a retry succeeds', async () => {
        MemoryAuditStore.failNext(1);

        expect(await Patient.query().where('Ward', 4)).to.have.length(2);
        expect(await recorded('restricted')).to.have.length(2);
      });

      it('rejects a stream before its first row', async () => {
        MemoryAuditStore.failNext(2);
        const read = async (): Promise<void> => {
          for await (const _patient of Patient.query().order('Id', SortOrder.ASC).stream()) {
            throw new Error('a row was yielded');
          }
        };

        await expect(read()).to.be.rejectedWith(AuditWriteFailed);
      });

      it('a continue rule lets the rows through when the write fails', async () => {
        await db.drop(dialect, SEARCH_TABLE);

        expect(await Visit.query().where('Id', 1)).to.have.length(1);
      });

      it("keeps the read record when the caller's transaction rolls back", async function () {
        // One physical connection: there the record cannot leave the caller's transaction.
        if (dialect === 'sqlite' || dialect === 'pglite') this.skip();
        const failing = db.driver(dialect).transaction(async () => {
          await Visit.query().where('Id', 1);
          throw new Error('caller failed');
        });

        await expect(failing).to.be.rejectedWith('caller failed');
        expect(await searched()).to.have.length(1);
      });

      it('pins a known limitation: inside a transaction on a single-connection driver the read waits for the transaction to end', async function () {
        if (dialect !== 'sqlite' && dialect !== 'pglite') this.skip();
        let settled = false;
        let pending: Promise<unknown> = Promise.resolve();
        await db.driver(dialect).transaction(async () => {
          pending = Promise.resolve(Visit.query().where('Id', 1)).finally(() => (settled = true));
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(settled).to.eq(false);
        });

        expect(await pending).to.have.length(1);
        expect(await searched()).to.have.length(1);
      });
    });
  }
});
