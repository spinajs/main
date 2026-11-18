import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import { audit, trailConfig } from '@spinajs/audit';
import type { AuditEvent, AuditInput, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import { TableAuditReader, auditEventColumns, insertRows, rowsOf, storedColumns } from '../src/index.js';
import { DIALECTS, TestDb } from '../src/testing.js';
import { trailTableOn } from '../src/trail-tables.js';
import type { Dialect } from '../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// Each trail owns its table, also when the trails sit on different connections.
const tableOf = (dialect: string): string => `audit_t_${dialect}`;
const SOURCED = 'audit_sourced';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const patient = { type: 'patient', id: '17' };
const trailOf = (dialect: string): string => `t_${dialect}`;
const TRAILS = Object.fromEntries(DIALECTS.map((d) => [trailOf(d), { connection: d, table: tableOf(d), onFailure: 'reject', retry: { attempts: 1, delay: 1 } }]));
const day = (n: number): Date => new Date(`2026-11-0${n}T10:00:00.000Z`);

// The shape of a reader over an archive: one table on one connection, the events of several sources told apart by a column.
class SourcedReader extends TableAuditReader {
  constructor(private readonly connection: OrmDriver) {
    super();
  }

  protected override driver(): OrmDriver {
    return this.connection;
  }

  protected override table(): string {
    return SOURCED;
  }

  protected override hasSourceColumn(): boolean {
    return true;
  }
}

// The reader of docs/audit 10: the trail's table under another name, filled by a sink of its own.
class LegacyReader extends TableAuditReader {
  protected override table(trail: TrailConfig): string {
    return `legacy_${trail.table}`;
  }
}

describe('TableAuditReader', function () {
  this.timeout(60000);
  let db: TestDb;

  const as = (id: string, traceId: string | undefined, fn: () => Promise<void>): Promise<void> => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).run({ Principal: { type: 'user', id }, traceId }, fn);

  before(async () => {
    db = await TestDb.open({ trails: TRAILS });
  });

  after(async () => {
    await db?.close();
  });

  it('a subclass over a table with a source column reads, redacts and prunes one source', async () => {
    const driver = db.driver('sqlite');
    await driver.schema().dropTable(SOURCED).ifExists();
    await driver.schema().createTable(SOURCED, (table) => {
      table.bigint('seq').primaryKey().autoIncrement();
      table.string('source', 64).notNull();
      auditEventColumns(table);
    });
    const event = (id: string, at: Date): AuditEvent => ({ id, at, kind: 'data', action: 'update', subject: patient, outcome: 'ok', actor: 'user:u1', data: { n: 1 } });
    await insertRows(driver, SOURCED, [
      { source: 'orders', ...storedColumns(event('e1', day(1))) },
      { source: 'billing', ...storedColumns(event('e2', day(2))) },
    ]);

    const reader = new SourcedReader(driver);
    const trail = trailConfig(trailOf('sqlite'));
    const page = { order: 'asc', limit: 10 } as const;
    expect((await reader.list(trail, { ...page, source: 'orders' })).map((e) => e.id)).to.deep.eq(['e1']);
    expect(await reader.list(trail, page)).to.deep.eq([]);
    expect(await reader.redact(trail, patient, 'billing')).to.eq(1);
    expect(await reader.redact(trail, patient, 'billing')).to.eq(0);
    expect((await reader.list(trail, { ...page, source: 'billing' })).map((e) => [e.id, e.redacted, e.data])).to.deep.eq([['e2', true, {}]]);
    expect(await reader.prune(trail, day(9), 'orders')).to.eq(1);
    expect(await reader.prune(trail, day(9))).to.eq(1);
    await driver.schema().dropTable(SOURCED).ifExists();
  });

  it("records the erasure on the source it redacted, also when the trail's own connection has no table", async function () {
    if (!db.has('pglite')) this.skip();
    const stored: AuditEvent = { id: 'e9', at: day(1), kind: 'data', action: 'update', subject: patient, outcome: 'ok', actor: 'user:u1', data: { n: 1 } };
    await db.migrate('pglite', tableOf('sqlite'));
    await insertRows(db.driver('pglite'), tableOf('sqlite'), [storedColumns(stored)]);

    // The trail's connection is sqlite, where audit_t does not exist at this point, and the trail rejects a failed write.
    expect(await audit().trail(trailOf('sqlite')).forget(patient, 'pglite')).to.eq(1);
    expect((await db.rows('pglite', tableOf('sqlite'))).map((r) => [r.action, r.data])).to.deep.eq([
      ['update', ''],
      ['erasure', '{"redacted":1}'],
    ]);
    await db.drop('pglite', tableOf('sqlite'));
  });

  for (const other of DIALECTS.filter((d) => d !== 'sqlite')) {
    it(`forgets a subject on every connection that holds the trail table, sqlite and ${other}, recording the erasure on each`, async function () {
      if (!db.has(other)) this.skip();
      const trail = trailOf('sqlite');
      const table = tableOf('sqlite');
      const update = (n: number): AuditInput => ({ kind: 'data', action: 'update', subject: patient, data: { n }, at: day(n) });
      await db.migrate('sqlite', table);
      await db.migrate(other, table);
      try {
        await audit().record(update(1), { trail });
        await audit().record([update(2), update(3)], { trail, connection: db.connectionName(other) });

        expect(await audit().trail(trail).forget(patient)).to.eq(3);
        const actions = async (dialect: Dialect): Promise<unknown[][]> => (await db.rows(dialect, table)).map((r) => [r.action, r.data]);
        expect(await actions('sqlite')).to.deep.eq([
          ['update', ''],
          ['erasure', '{"redacted":1}'],
        ]);
        expect(await actions(other)).to.deep.eq([
          ['update', ''],
          ['update', ''],
          ['erasure', '{"redacted":2}'],
        ]);

        // Nothing of this subject on the other connection: its erasure is recorded on the trail's connection only.
        expect(await audit().trail(trail).forget({ type: 'patient', id: '99' })).to.eq(0);
        expect(await db.rows('sqlite', table)).to.have.length(3);
        expect(await db.rows(other, table)).to.have.length(3);
      } finally {
        await db.drop('sqlite', table);
        await db.drop(other, table);
      }
    });
  }

  it('names a connection it cannot look at, and erases nothing', async function () {
    if (!db.has('pglite')) this.skip();
    const trail = trailOf('sqlite');
    const table = tableOf('sqlite');
    await db.migrate('sqlite', table);
    const pglite = db.driver('pglite');
    try {
      await audit().record({ kind: 'data', action: 'update', subject: patient, data: { n: 1 }, at: day(1) }, { trail });
      Reflect.set(pglite, 'tableInfo', () => Promise.reject(new Error('catalog refused')));
      await expect(audit().trail(trail).forget(patient)).to.be.rejectedWith(`audit: forget on trail "${trail}" could not look for table ${table} on connection "${pglite.Options.Name}", so nothing was erased: catalog refused`);
      expect((await db.rows('sqlite', table)).map((r) => r.data)).to.deep.eq(['{"n":1}']);
    } finally {
      Reflect.deleteProperty(pglite, 'tableInfo');
      await db.drop('sqlite', table);
    }
  });

  it('reads a missing table as none, also from a driver that answers null for it (MSSQL)', async () => {
    expect(await trailTableOn({ tableInfo: () => Promise.resolve(null) }, 'audit_missing')).to.eq('none');
    expect(await trailTableOn(db.driver('sqlite'), 'audit_missing')).to.eq('none');
  });

  it('leaves a table of the trail name without the trail columns alone', async function () {
    if (!db.has('pglite')) this.skip();
    const trail = trailOf('sqlite');
    const table = tableOf('sqlite');
    await db.migrate('sqlite', table);
    await db.driver('pglite').schema().dropTable(table).ifExists();
    await db
      .driver('pglite')
      .schema()
      .createTable(table, (t) => {
        t.string('subject_type', 64);
        t.string('subject_id', 64);
        t.longtext('data');
      });
    try {
      await db.driver('pglite').insert().into(table).values({ subject_type: patient.type, subject_id: patient.id, data: 'kept' });
      await audit().record({ kind: 'data', action: 'update', subject: patient, data: { n: 1 }, at: day(1) }, { trail });

      expect(await audit().trail(trail).forget(patient)).to.eq(1);
      expect((await db.rows('sqlite', table)).map((r) => r.data)).to.deep.eq(['', '{"redacted":1}']);
      expect(rowsOf(await db.driver('pglite').select().from(table)).map((r) => r.data)).to.deep.eq(['kept']);
    } finally {
      await db.drop('sqlite', table);
      await db.driver('pglite').schema().dropTable(table).ifExists();
    }
  });

  it('erases through a subclass over another table on its own connection only', async function () {
    if (!db.has('pglite')) this.skip();
    const trail = trailConfig(trailOf('sqlite'));
    const legacy = `legacy_${tableOf('sqlite')}`;
    const stored: AuditEvent = { id: 'e1', at: day(1), kind: 'data', action: 'update', subject: patient, outcome: 'ok', actor: 'user:u1', data: { n: 1 } };
    for (const dialect of ['sqlite', 'pglite'] as const) {
      await db.migrate(dialect, legacy);
      await insertRows(db.driver(dialect), legacy, [storedColumns(stored)]);
    }
    try {
      const reader = new LegacyReader();
      const redactions: unknown[] = [];
      for await (const redaction of reader.redactEach(trail, patient)) redactions.push(redaction);
      expect(redactions).to.deep.eq([{ connection: undefined, redacted: 1 }]);
      expect((await db.rows('pglite', legacy)).map((r) => r.data)).to.deep.eq(['{"n":1}']);
    } finally {
      await db.drop('sqlite', legacy);
      await db.drop('pglite', legacy);
    }
  });

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      const trail = trailOf(dialect);

      before(function () {
        if (!db.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        await db.migrate(dialect, tableOf(dialect));
        await as('u1', TRACE, () =>
          audit().record(
            [
              { kind: 'read', action: 'patient.read', subject: patient, data: { columns: ['ssn'] }, at: day(1) },
              { kind: 'action', action: 'report.export', at: day(2) },
            ],
            { trail },
          ),
        );
        await as('u2', undefined, () => audit().record({ kind: 'data', action: 'update', subject: patient, data: { changed: ['ward'] }, at: day(3) }, { trail }));
      });

      afterEach(async () => {
        await db.drop(dialect, tableOf(dialect));
      });

      it('answers by actor, by subject and by trace, oldest first', async () => {
        const events = audit().trail(trail);
        expect((await events.byActor('user:u1')).map((e) => e.action)).to.deep.eq(['patient.read', 'report.export']);

        const about = await events.of(patient);
        expect(about.map((e) => [e.actor, e.kind, e.data])).to.deep.eq([
          ['user:u1', 'read', { columns: ['ssn'] }],
          ['user:u2', 'data', { changed: ['ward'] }],
        ]);
        expect(about[0]).to.include({ outcome: 'ok', traceId: TRACE, redacted: false });
        expect(about[0].subject).to.deep.eq(patient);
        expect(about[0].at.toISOString()).to.eq(day(1).toISOString());
        expect(about[1].seq).to.be.greaterThan(about[0].seq);
        expect(await events.byTrace(TRACE)).to.have.length(2);
      });

      it('pages by seq and narrows by kind, action and time', async () => {
        const events = audit().trail(trail);
        const first = await events.since(0, { limit: 2 });
        expect(first.map((e) => e.action)).to.deep.eq(['patient.read', 'report.export']);
        expect((await events.since(first[1].seq)).map((e) => e.action)).to.deep.eq(['update']);
        expect((await events.since(0, { kinds: ['read', 'data'] })).map((e) => e.kind)).to.deep.eq(['read', 'data']);
        expect(await events.since(0, { actions: ['report.export'] })).to.have.length(1);
        expect((await events.since(0, { from: new Date('2026-11-02T00:00:00.000Z'), to: new Date('2026-11-02T23:00:00.000Z') })).map((e) => e.action)).to.deep.eq(['report.export']);
        expect(await events.since(0, { kinds: [] })).to.deep.eq([]);
        expect((await events.since(0, { subjectType: 'patient', order: 'desc' })).map((e) => e.action)).to.deep.eq(['update', 'patient.read']);
        expect((await events.of(patient, { order: 'desc', limit: 1 })).map((e) => e.action)).to.deep.eq(['update']);
      });

      it('blanks an event of another kind named erasure, and keeps the erasure records forget wrote', async () => {
        const events = audit().trail(trail);
        await events.forget(patient);
        await audit().record({ kind: 'action', action: 'erasure', subject: patient, data: { email: 'a@example.com' } }, { trail });

        expect(await events.forget(patient)).to.eq(1);
        const erasures = (await db.rows(dialect, tableOf(dialect))).filter((r) => r.action === 'erasure').map((r) => [r.kind, r.data]);
        expect(erasures).to.deep.eq([
          ['custom', '{"redacted":2}'],
          ['action', ''],
          ['custom', '{"redacted":1}'],
        ]);
      });

      it('redacts a subject, keeps the payload hashes and records the erasure', async () => {
        const before = await db.rows(dialect, tableOf(dialect));
        const events = audit().trail(trail);
        expect(await events.forget(patient)).to.eq(2);

        expect((await events.of(patient)).map((e) => [e.action, e.redacted, e.data])).to.deep.eq([
          ['patient.read', true, {}],
          ['update', true, {}],
          ['erasure', false, { redacted: 2 }],
        ]);
        const rows = await db.rows(dialect, tableOf(dialect));
        expect(rows.map((r) => r.data)).to.deep.eq(['', '{}', '', '{"redacted":2}']);
        const withoutData = ({ data: _data, ...rest }: Record<string, unknown>): Record<string, unknown> => rest;
        expect(rows.slice(0, 3).map(withoutData)).to.deep.eq(before.map(withoutData));
      });

      it('keeps a subject as spelled and erases that spelling only', async () => {
        const events = audit().trail(trail);
        const user = (id: string) => ({ type: 'user', id });
        await audit().record(['Łukasz-7', 'ABC', 'abc'].map((id): AuditInput => ({ kind: 'data', action: 'update', subject: user(id), data: { name: 'Łukasz Żółć' } })), { trail });

        expect(await events.forget(user('abc'))).to.eq(1);
        const [lukasz] = await events.of(user('Łukasz-7'));
        expect([lukasz?.subject, lukasz?.data]).to.deep.eq([user('Łukasz-7'), { name: 'Łukasz Żółć' }]);
        expect((await events.of(user('ABC'))).map((e) => [e.subject?.id, e.redacted])).to.deep.eq([['ABC', false]]);
      });

      it('prunes more than one chunk', async () => {
        const old = Array.from({ length: 501 }, (_unused, i): AuditEvent => ({ id: `p${i}`, at: day(4), kind: 'action', action: 'old', outcome: 'ok', actor: 'user:u1', data: {} }));
        await insertRows(db.driver(dialect), tableOf(dialect), old.map(storedColumns));
        expect(await new TableAuditReader().prune(trailConfig(trail), day(5))).to.eq(504);
        expect(await db.rows(dialect, tableOf(dialect))).to.have.length(0);
      });
    });
  }
});
