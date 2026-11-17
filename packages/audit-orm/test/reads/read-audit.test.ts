import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { AuditConfigError, AuditStore, AuditWriteFailed, audit } from '@spinajs/audit';
import { MemoryAuditStore } from '@spinajs/audit/testing';
// Relation is imported as a value: the decorators read the property's emitted design type.
import { BelongsTo, Connection, HasMany, HasManyToMany, Model, ModelBase, Orm, Primary, QueryMiddleware, RawQuery, Relation, SortOrder, extractModelDescriptor } from '@spinajs/orm';
import type { OrmDriver, SingleRelation, TableQueryBuilder } from '@spinajs/orm';

import { AuditReads, AuditTrailTableMigration, ReadAuditMiddleware, auditSubjectType, registerAuditReads } from '../../src/index.js';
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

// A rule on a base class applies to the subclass, directly and where another model joins it.
@AuditReads({ trail: 'restricted', columns: ['Code'] })
class Charted<M> extends ModelBase<M> {
  @Primary()
  public Id: number;

  public Code: string;
}

@Connection('sqlite')
@Model('ward')
class Ward extends Charted<Ward> {
  @HasMany(Patient, { foreignKey: 'Ward', primaryKey: 'Id' })
  public Patients: Relation<Patient, Ward>;
}

@Connection('sqlite')
@Model('doctor_ward')
class DoctorWard extends ModelBase<DoctorWard> {
  @Primary()
  public Id: number;

  public doctor_id: number;

  public ward_id: number;
}

@Connection('sqlite')
@Model('doctor')
class Doctor extends ModelBase<Doctor> {
  @Primary()
  public Id: number;

  @HasManyToMany(DoctorWard, Ward, { junctionModelSourcePk: 'doctor_id', junctionModelTargetPk: 'ward_id' })
  public Wards: Relation<Ward, Doctor>;
}

@Connection('sqlite')
@Model('badge')
@AuditReads({ trail: 'restricted' })
class Badge extends ModelBase<Badge> {
  @Primary()
  public Id: Buffer;

  public Holder: string;
}

@Connection('sqlite')
@Model('clinic')
class Clinic extends ModelBase<Clinic> {
  @Primary()
  public Id: number;

  public Title: string;
}

// A relation named like another model's class: Patient targets Clinic, Attendee targets Patient.
@Connection('sqlite')
@Model('appointment')
class Appointment extends ModelBase<Appointment> {
  @Primary()
  public Id: number;

  public clinic_id: number;

  public patient_id: number;

  @BelongsTo(Clinic, 'clinic_id', 'Id')
  public Patient: SingleRelation<Clinic>;

  @BelongsTo(Patient, 'patient_id', 'Id')
  public Attendee: SingleRelation<Patient>;
}

// Its trail lives on its own single connection, where save() opens the transaction its reload runs in.
@Connection('wedge')
@Model('chart')
@AuditReads({ trail: 'wedge', mode: 'query' })
class Chart extends ModelBase<Chart> {
  @Primary()
  public Id: number;

  public Name: string;
}

class NamedTrail extends AuditTrailTableMigration {
  constructor(private readonly name: string) {
    super();
  }

  protected override table(): string {
    return this.name;
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const RETRY = { attempts: 2, delay: '1ms' };
const AUDIT = {
  trails: {
    restricted: { store: 'TestAuditStore', onFailure: 'reject', retry: RETRY },
    ...Object.fromEntries(DIALECTS.map((d) => [searches(d), { connection: d, table: searches(d), retry: RETRY }])),
    wedge: { connection: 'wedge', table: 'audit_wedge', onFailure: 'reject', retry: RETRY },
    held: { connection: 'wedge', table: 'audit_held', onFailure: 'reject', retry: RETRY },
  },
  confirmTimeoutMs: 1500,
};
const WEDGE = { Driver: 'orm-driver-sqlite', Name: 'wedge', Filename: ':memory:' };

async function createTables(driver: OrmDriver, tables: Record<string, (table: TableQueryBuilder) => void>): Promise<void> {
  for (const [name, columns] of Object.entries(tables)) {
    await driver.schema().dropTable(name).ifExists();
    await driver.schema().createTable(name, columns);
  }
}

async function seed(db: TestDb, dialect: Dialect, models: Models): Promise<void> {
  await createTables(db.driver(dialect), {
    patient: (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
      t.string('Ssn');
      t.int('Ward');
    },
    visit: (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Reason');
      t.int('patient_id');
    },
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
    db = await TestDb.open(AUDIT, { connections: [WEDGE] });
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
        await db.migrate(dialect, searches(dialect));
      });

      after(async () => {
        if (!db.has(dialect)) return;
        await db.drop(dialect, searches(dialect));
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
        expect(event.subject).to.deep.eq({ type: auditSubjectType(Patient), id: '1' });
        expect(auditSubjectType(Patient)).to.eq(extractModelDescriptor(Patient)?.TableName);
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

      it('records a count and an exists in query mode, as statements that disclosed no column', async () => {
        await Visit.query().where('Reason', 'checkup').selectCount();
        // ModelBase declares exists() without the key it takes.
        await Reflect.apply(Visit.exists.bind(Visit), undefined, [1]);

        expect((await searched()).map((e) => (e.data as { columns: unknown[] }).columns)).to.deep.eq([[], []]);
      });

      it('audits the columns a belongsTo populate joins in, once per related row', async () => {
        await Visit.query().populate('Patient');

        const events = await recorded('restricted');
        expect(events.map((e) => e.subject?.id).sort()).to.deep.eq(['1', '2']);
        expect(events.map((e) => e.subject?.type)).to.deep.eq(['patient', 'patient']);
        expect(events[0].data).to.deep.eq({ columns: ['Ssn'] });
      });

      it('attributes a column to the table its alias names, when a join or a populate renames it', async () => {
        const positiveId = function (this: { where(column: string, operator: string, value: number): unknown }) {
          this.where('Id', '>', 0);
        };
        await Visit.query()
          .leftJoin('Patient', positiveId, function () {
            this.select('Ssn', 'PatientSsn');
          })
          .asRaw();
        await Visit.query()
          .populate('Patient', function () {
            this.clearColumns();
            this.select('Ssn', 'x');
          })
          .asRaw();

        const keyless = { columns: ['Ssn'], rows: 3, filter: [], keyless: true };
        expect((await recorded('restricted')).map((e) => [e.action, e.subject, e.data])).to.deep.eq([
          ['patient.read', undefined, keyless],
          ['patient.read', undefined, keyless],
        ]);
      });

      it('reads a join by the alias it is declared with, whatever model that alias also names', async () => {
        const join = (joinTableAlias: string, column: string) => ({
          joinModel: Patient,
          joinTableAlias,
          sourceTablePrimaryKey: 'patient_id',
          joinTableForeignKey: 'Id',
          callback: function (this: { where(column: string, operator: string, value: number): unknown }) {
            this.where('Id', '>', 0);
          },
          queryCallback: function (this: { select(column: string, alias?: string): unknown }) {
            this.select(column, column === '*' ? undefined : 'x');
          },
        });
        await Visit.query().leftJoin(join('ward', 'Ssn')).asRaw();
        await Visit.query().leftJoin(join('p', '*')).asRaw();

        const keyless = { columns: ['Ssn'], rows: 3, filter: [], keyless: true };
        expect((await recorded('restricted')).map((e) => [e.action, e.data])).to.deep.eq([
          ['patient.read', keyless],
          ['patient.read', keyless],
        ]);
      });

      it('counts an aggregate in a query with a join for every table of the query that has the column', async () => {
        const positive = function (this: { where(column: string, operator: string, value: number): unknown }) {
          this.where('Id', '>', 0);
        };
        // Strict column typing refuses a joined column on Visit's builder; a package without it can write it.
        const ungrouped = Visit.query().leftJoin('Patient', positive);
        Reflect.apply(ungrouped.max.bind(ungrouped), undefined, ['Ssn', 'S']);
        await ungrouped.asRaw();
        const grouped = Visit.query().leftJoin('Patient', positive).select('Reason');
        Reflect.apply(grouped.max.bind(grouped), undefined, ['Ssn', 'S']);
        await grouped.groupBy('Reason').asRaw();

        expect((await recorded('restricted')).map((e) => [e.action, e.subject, e.data])).to.deep.eq([
          ['patient.read', undefined, { columns: ['Ssn'], rows: 1, filter: [], keyless: true }],
          ['patient.read', undefined, { columns: ['Ssn'], rows: 3, filter: [], keyless: true }],
        ]);
      });

      it('audits an own column under an alias of its own', async () => {
        await Patient.query().select('Id').select('Ssn', 'x').where('Id', 1).asRaw();

        expect((await recorded('restricted')).map((e) => [e.subject?.id, e.data])).to.deep.eq([['1', { columns: ['Ssn'] }]]);
      });

      it('names no row when another column takes the output name of the key', async () => {
        await Patient.query().select('Id').select('Ssn').select('Name', 'Id').asRaw();
        await Patient.query().select('Id').select('Ssn', 'Id').asRaw();

        const keyless = { columns: ['Ssn'], rows: 3, filter: [], keyless: true };
        expect((await recorded('restricted')).map((e) => [e.subject, e.data])).to.deep.eq([
          [undefined, keyless],
          [undefined, keyless],
        ]);
      });

      it('keeps naming rows when a condition column sits next to the key', async () => {
        await Patient.query()
          .select('*')
          .selectCondition('inWard4', function () {
            this.where('Ward', 4);
          })
          .asRaw();

        expect((await recorded('restricted')).map((e) => [e.subject?.id, e.data])).to.deep.eq([
          ['1', { columns: ['Ssn'] }],
          ['2', { columns: ['Ssn'] }],
          ['3', { columns: ['Ssn'] }],
        ]);
      });

      it('matches column names without regard to case', async () => {
        // This package types columns strictly; a package that does not can write the other spelling.
        const query = Patient.query();
        Reflect.apply(query.columns.bind(query), undefined, [['Id', 'ssn']]);
        const read = query.asRaw();
        if (dialect === 'postgres' || dialect === 'pglite') {
          // Every identifier is quoted, and a quoted Postgres identifier keeps its case: "ssn" is no column there.
          await expect(read).to.be.rejectedWith(/ssn/);
          return;
        }

        await read;
        expect((await recorded('restricted')).map((e) => [e.subject?.id, e.data])).to.deep.eq([
          ['1', { columns: ['Ssn'] }],
          ['2', { columns: ['Ssn'] }],
          ['3', { columns: ['Ssn'] }],
        ]);
      });

      it('audits an aggregate over an audited column as one statement, and none over other columns', async () => {
        await Patient.query().select('Id').max('Ssn', 'S').groupBy('Id').asRaw();
        await Patient.query().max('Ward', 'W').asRaw();

        expect((await recorded('restricted')).map((e) => [e.subject, e.data])).to.deep.eq([[undefined, { columns: ['Ssn'], rows: 3, filter: [], keyless: true }]]);
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
        await db.drop(dialect, searches(dialect));

        expect(await Visit.query().where('Id', 1)).to.have.length(1);
      });

      it("keeps the read record when the caller's transaction rolls back, except on a single connection, where it joined that transaction", async () => {
        const failing = db.driver(dialect).transaction(async () => {
          await Visit.query().where('Id', 1);
          throw new Error('caller failed');
        });

        await expect(failing).to.be.rejectedWith('caller failed');
        expect(await searched()).to.have.length(dialect === 'sqlite' || dialect === 'pglite' ? 0 : 1);
      });

      it('returns an audited read inside a transaction, and its record commits', async () => {
        await db.driver(dialect).transaction(async () => {
          expect(await Visit.query().where('Id', 1)).to.have.length(1);
        });

        expect(await searched()).to.have.length(1);
      });
    });
  }

  describe('relations, keys and limits (sqlite)', () => {
    before(async () => {
      const driver = db.driver('sqlite');
      await seed(db, 'sqlite', MODELS.sqlite);
      await createTables(driver, {
        ward: (t) => {
          t.int('Id').primaryKey();
          t.string('Code');
        },
        doctor: (t) => t.int('Id').primaryKey(),
        doctor_ward: (t) => {
          t.int('Id').primaryKey().autoIncrement();
          t.int('doctor_id');
          t.int('ward_id');
        },
        badge: (t) => {
          t.binary('Id', 2).primaryKey();
          t.string('Holder');
        },
        clinic: (t) => {
          t.int('Id').primaryKey().autoIncrement();
          t.string('Title');
        },
        appointment: (t) => {
          t.int('Id').primaryKey().autoIncrement();
          t.int('clinic_id');
          t.int('patient_id');
        },
      });
      await createTables(db.driver('wedge'), {
        chart: (t) => {
          t.int('Id').primaryKey().autoIncrement();
          t.string('Name');
        },
      });
      await db.migrate('sqlite', searches('sqlite'));
      await new NamedTrail('audit_wedge').up(db.driver('wedge'));
      await new NamedTrail('audit_held').up(db.driver('wedge'));
      await (await DI.resolve(Orm)).reloadTableInfo({ models: [Ward, Doctor, DoctorWard, Badge, Chart, Clinic, Appointment] });

      await Ward.insert({ Id: 4, Code: 'W4' });
      await Ward.insert({ Id: 5, Code: 'W5' });
      await Doctor.insert({ Id: 1 });
      await DoctorWard.insert({ doctor_id: 1, ward_id: 4 });
      await Badge.insert({ Id: Buffer.from('ab01', 'hex'), Holder: 'Ada' });
      await Chart.insert({ Name: 'x' });
      await Clinic.insert({ Title: 'C1' });
      await Appointment.insert({ clinic_id: 1, patient_id: 2 });
    });

    const of = async (type: string) => (await recorded('restricted')).filter((e) => e.subject?.type === type || (e.subject === undefined && e.action === `${type}.read`));

    it('audits the rows of a hasMany populate', async () => {
      await Ward.query().populate('Patients');

      expect((await of('patient')).map((e) => e.subject?.id).sort()).to.deep.eq(['1', '2', '3']);
    });

    it('audits the targets of a many-to-many populate, by a rule its base class declares', async () => {
      await Doctor.query().populate('Wards');

      expect((await of('ward')).map((e) => [e.subject?.id, e.data])).to.deep.eq([['4', { columns: ['Code'] }]]);
    });

    it('audits relations loaded through their accessors', async () => {
      const visit = await MODELS.sqlite.Visit.get(1);
      const ward = await Ward.get(4);
      resetTrail();

      await visit.Patient.populate();
      await ward.Patients.populate();

      expect((await of('patient')).map((e) => e.subject?.id)).to.deep.eq(['1', '1', '2']);
    });

    it('records no count and no exists in row mode: they return no row of the model', async () => {
      await Badge.query().selectCount();
      await Reflect.apply(Badge.exists.bind(Badge), undefined, [Buffer.from('ab01', 'hex')]);

      expect(await of('badge')).to.deep.eq([]);
    });

    it('names a row by a binary key as hex', async () => {
      await Badge.all();

      expect((await of('badge')).map((e) => e.subject?.id)).to.deep.eq(['ab01']);
    });

    it('counts an expression for every table of the query, and of no other', async () => {
      await MODELS.sqlite.Visit.query()
        .leftJoin('Patient', function () {
          this.where('Id', '>', 0);
        })
        .select(RawQuery.create('1 AS one'))
        .asRaw();

      expect((await recorded('restricted')).map((e) => [e.action, e.data])).to.deep.eq([['patient.read', { columns: ['Ssn'], rows: 3, filter: [], keyless: true }]]);
    });

    it('reads a join under the alias of its model, not as the relation that alias also names', async () => {
      await Appointment.query()
        .leftJoin(
          'Attendee',
          function () {
            this.where('Id', '>', 0);
          },
          function () {
            this.select('Ssn', 'x');
          },
        )
        .asRaw();

      expect((await of('patient')).map((e) => e.data)).to.deep.eq([{ columns: ['Ssn'], rows: 1, filter: [], keyless: true }]);
    });

    it('records the reload of save({ reload: true }) in the transaction save() opens', async () => {
      const chart = await Chart.get(1);
      chart.Name = 'y';
      await chart.save({ reload: true });

      expect((await audit().trail('wedge').since(0)).map((e) => e.action)).to.deep.eq(['chart.read', 'chart.read']);
    });

    it('fails the select when its record cannot join a transaction and waits past audit.confirmTimeoutMs', async () => {
      registerAuditReads(DoctorWard, { trail: 'held', mode: 'query' });
      const held = db.driver('wedge').transaction(() => pause(3000));

      await expect(DoctorWard.all()).to.be.rejectedWith(AuditWriteFailed);
      await held;
    });

    it('fails the first audited select of a rule that names a column the table lacks', async () => {
      registerAuditReads(Doctor, { trail: 'restricted', mode: 'query', columns: ['Nope'] });

      await expect(Doctor.all()).to.be.rejectedWith(AuditConfigError, '@AuditReads on Doctor: doctor has no column Nope');
    });
  });
});
