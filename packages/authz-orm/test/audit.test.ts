import * as chai from 'chai';
import 'mocha';

import { AuthorizationModel, DecisionAudit } from '@spinajs/authz';
import type { HostLog, Principal, Trace } from '@spinajs/authz';
import { RecordingAudit, StaticModel, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { MIGRATION_DESCRIPTION_SYMBOL } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { AUDIT_CONNECTION, AUDIT_TABLE, AuthzAuditEntry, AuthzAudit_2026_10_01_00_00_00, DbDecisionAudit } from '../src/audit/index.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { asSystem } from './support/system.js';

const expect = chai.expect;

type Row = { id: string; at: unknown; kind: string; principal: string; permission: string | null; resource: string | null; reason: string | null; trace: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };

/** A HostLog that keeps its lines. */
const recordingLog = () => {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => void lines.push({ level, message });
  const log: HostLog = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
  return { log, lines };
};

const trace: Trace = { domain: 'root', algorithm: 'deny-overrides', models: ['m1'], votes: [], steps: [{ by: 'core', step: 'deny', note: "no permit for 'x'\nline two" }], durationMs: 1.5 };

/**
 * `at` holds UTC wall time without an offset. The raw driver value: on SQLite the orm's datetime
 * text; on Postgres a Date that pg built by reading that wall time as local time.
 */
const time = (v: unknown): number => {
  if (v instanceof Date) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds(), v.getMilliseconds());
  expect(v).to.match(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
  return new Date(`${String(v).replace(' ', 'T')}Z`).getTime();
};

describe('authz-orm DbDecisionAudit', function () {
  this.timeout(120000);
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
  });

  it('the migration is registered for the authz-audit connection, which an app maps with db.Aliases', () => {
    expect(DI.getRegisteredTypes('__migrations__')).to.include(AuthzAudit_2026_10_01_00_00_00);
    expect((AuthzAudit_2026_10_01_00_00_00 as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal(AUDIT_CONNECTION);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let db: TestDb;
      let driver: OrmDriver;
      const migration = new AuthzAudit_2026_10_01_00_00_00();
      const undo: (() => void | Promise<void>)[] = [];

      const rows = async (): Promise<Row[]> => (await db.raw(`SELECT * FROM ${AUDIT_TABLE} ORDER BY at, id`, [], dialect)) as Row[];
      const reset = async () => {
        await migration.down(driver);
        await migration.up(driver);
        await db.orm.reloadTableInfo();
      };

      before(async function () {
        if (dialect === 'postgres' && !pg) return this.skip();
        db = await TestDb.open({ postgres: dialect === 'postgres' });
        driver = db.driver(dialect);
        db.orm.Connections.set(AUDIT_CONNECTION, driver);
        // The Postgres database is shared between runs: start from no table.
        await migration.down(driver);
      });

      afterEach(async () => {
        for (const fn of undo.splice(0).reverse()) await fn();
      });

      after(async () => {
        if (!db) return;
        await migration.down(driver);
        // The alias is the same driver: Orm.dispose would disconnect it twice.
        db.orm.Connections.delete(AUDIT_CONNECTION);
        await db.close();
      });

      it('the migration creates authz_audit and its index authz_audit_at; down drops them', async () => {
        await migration.up(driver);
        expect(await driver.schema().tableExists(AUDIT_TABLE)).to.equal(true);
        const indexes = dialect === 'sqlite' ? await db.raw(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'authz_audit_at'`) : await db.raw(`SELECT indexname AS name FROM pg_indexes WHERE indexname = 'authz_audit_at'`, [], dialect);
        expect((indexes as { name: string }[]).map((r) => r.name)).to.deep.equal(['authz_audit_at']);
        const columns = (await driver.tableInfo(AUDIT_TABLE, driver.Options.Database)).map((c) => [c.Name, c.Nullable]);
        expect(Object.fromEntries(columns)).to.deep.equal({ id: false, at: false, kind: false, principal: false, permission: true, resource: true, reason: true, trace: true });

        await migration.down(driver);
        expect(await driver.schema().tableExists(AUDIT_TABLE)).to.equal(false);
        const left = dialect === 'sqlite' ? await db.raw(`SELECT name FROM sqlite_master WHERE name = 'authz_audit_at'`) : await db.raw(`SELECT indexname FROM pg_indexes WHERE indexname = 'authz_audit_at'`, [], dialect);
        expect(left).to.have.length(0);
      });

      it('a record round trip: one row per record, read back through the model', async () => {
        await reset();
        const { log, lines } = recordingLog();
        const audit = new DbDecisionAudit(log);
        const before = Date.now();
        await audit.record({ kind: 'deny', principal: { type: 'user', id: 'alice' }, permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, reason: 'no-permit', trace });
        await audit.record({ kind: 'runAs', principal: { type: 'service', id: 'jobs' }, reason: 'nightly' });
        await audit.record({ kind: 'unscoped', principal: { type: 'user', id: 'bob' }, permission: 'doc:read', resource: { type: 'doc' }, reason: 'export' });
        await audit.record({ kind: 'admin', principal: { type: 'user', id: 'root' }, command: { kind: 'assign', role: 'editor' } });
        const after = Date.now();
        expect(lines).to.deep.equal([]);

        const all = await rows();
        expect(all).to.have.length(4);
        for (const r of all) {
          expect(r.id).to.match(UUID);
          expect(time(r.at)).to.be.within(before - 1000, after + 1000);
        }
        const byKind = Object.fromEntries(all.map((r) => [r.kind, r]));
        expect(byKind.deny).to.include({ principal: 'user:alice', permission: 'doc:read', resource: 'doc:d1', reason: 'no-permit' });
        expect(JSON.parse(byKind.deny.trace!)).to.deep.equal(trace);
        expect(byKind.runAs).to.include({ principal: 'service:jobs', permission: null, resource: null, reason: 'nightly', trace: null });
        expect(byKind.unscoped).to.include({ resource: 'doc', reason: 'export', trace: null });
        expect(byKind.admin).to.include({ permission: null, resource: null, reason: null });
        expect(JSON.parse(byKind.admin.trace!)).to.deep.equal({ kind: 'assign', role: 'editor' });

        const models = (await asSystem(() => (AuthzAuditEntry as any).where('kind', 'deny'))) as AuthzAuditEntry[];
        expect(models).to.have.length(1);
        expect(models[0]).to.be.instanceOf(AuthzAuditEntry);
        expect(models[0]).to.include({ id: byKind.deny.id, principal: 'user:alice', resource: 'doc:d1' });
        // Through the model `at` is a luxon DateTime on both dialects, its wall time UTC.
        const at = (models[0] as unknown as { at: unknown }).at;
        expect(DateTime.isDateTime(at), `${dialect} at is a DateTime`).to.equal(true);
        expect((at as DateTime).setZone('utc', { keepLocalTime: true }).toMillis()).to.be.within(before - 1000, after + 1000);
      });

      it('values with quotes, newlines and SQL syntax are stored as they are; long ones are cut to the column', async () => {
        await reset();
        const audit = new DbDecisionAudit(recordingLog().log);
        const reason = `it's "quoted"\n-- not a comment; DROP TABLE ${AUDIT_TABLE}; /* x */\r\n\ttab`;
        await audit.record({ kind: 'deny', principal: { type: 'user', id: 'o\'brien\n"x"' }, permission: "doc:'read'", resource: { type: 'doc', id: 'd\'1\n"; --' }, reason, trace: { ...trace, steps: [{ by: 'core', step: "'", note: '"\n\\' }] } });
        const [row] = await rows();
        expect(row).to.include({ principal: 'user:o\'brien\n"x"', permission: "doc:'read'", resource: 'doc:d\'1\n"; --', reason });
        expect(JSON.parse(row.trace!).steps).to.deep.equal([{ by: 'core', step: "'", note: '"\n\\' }]);
        expect(await driver.schema().tableExists(AUDIT_TABLE)).to.equal(true);

        await reset();
        const astral = '\u{1F600}';
        await audit.record({ kind: 'deny', principal: { type: 'user', id: 'u'.repeat(200) }, permission: 'p'.repeat(300), resource: { type: 'doc', id: astral.repeat(300) }, reason: 'r'.repeat(300) });
        const [long] = await rows();
        expect(long.principal).to.equal(`user:${'u'.repeat(95)}`);
        expect(long.permission).to.equal('p'.repeat(160));
        expect(long.resource).to.equal(`doc:${astral.repeat(251)}`);
        expect(long.reason).to.equal('r'.repeat(255));
      });

      it('a failing database never rejects: the record is logged and dropped', async () => {
        await reset();
        const { log, lines } = recordingLog();
        const audit = new DbDecisionAudit(log);

        await migration.down(driver);
        await audit.record({ kind: 'deny', principal: { type: 'user', id: 'alice' }, permission: 'doc:read' });
        expect(lines.map((l) => l.level)).to.deep.equal(['error']);
        expect(lines[0].message).to.match(/deny entry to authz_audit failed, the entry is dropped/);

        await reset();
        db.orm.Connections.delete(AUDIT_CONNECTION);
        undo.push(() => void db.orm.Connections.set(AUDIT_CONNECTION, driver));
        await audit.record({ kind: 'runAs', principal: { type: 'user', id: 'alice' } });
        expect(lines.map((l) => l.level)).to.deep.equal(['error', 'error']);
        db.orm.Connections.set(AUDIT_CONNECTION, driver);
        expect(await rows()).to.have.length(0);

        // Not JSON: the row is still written, without its trace.
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        await audit.record({ kind: 'deny', principal: { type: 'user', id: 'alice' }, trace: cyclic as never });
        expect(lines.map((l) => l.level)).to.deep.equal(['error', 'error', 'warn']);
        expect((await rows()).map((r) => [r.kind, r.trace])).to.deep.equal([['deny', null]]);

        expect(await audit.record(null as never)).to.equal(undefined);
        expect(lines.map((l) => l.level)).to.deep.equal(['error', 'error', 'warn', 'error']);
      });

      describe('as the domain audit, picked by authz.audit.service', () => {
        let domainSeq = 0;

        const setConfig = (path: string[], value: unknown) => {
          const config = testHost.config();
          const prev = config.get<unknown>(path);
          config.set(path, value);
          undo.push(() => (prev === undefined ? config.unset(path) : config.set(path, prev)));
        };

        async function domain() {
          const ds = await testHost.domains();
          const name = `audit${dialect}${++domainSeq}`;
          setConfig(['authz', 'domains', name], { permissions: { 'adoc:read': { types: ['adoc'] } }, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 }, audit: { service: 'DbDecisionAudit' } });
          const container: IContainer = ds.create(name, 'root');
          undo.push(() => (ds.names().includes(name) ? container.dispose() : undefined));
          container.register(testHost.instance(new StaticModel({ name: 'm1', votes: {} }))).as(AuthorizationModel);
          container.register(DbDecisionAudit).as(DecisionAudit);
          // Registered later, so the resolve without the config key would pick it.
          const recording = new RecordingAudit();
          container.register(testHost.instance(recording)).as(DecisionAudit);
          return { service: await ds.service(name), recording };
        }

        const eventually = async (fn: () => Promise<boolean>) => {
          for (let i = 0; i < 100 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 50));
        };

        it('a denied check writes a row; with the table gone the check still answers', async () => {
          await reset();
          const { service, recording } = await domain();
          const denied = await service.check({ principal: alice, permission: 'adoc:read', resource: { type: 'adoc', id: "x'1" } });
          expect(denied.allowed).to.equal(false);
          await eventually(async () => (await rows()).length > 0);
          const [row] = await rows();
          expect(row).to.include({ kind: 'deny', principal: 'user:alice', permission: 'adoc:read', resource: "adoc:x'1" });
          expect(recording.entries).to.deep.equal([]);

          await migration.down(driver);
          const again = await service.check({ principal: alice, permission: 'adoc:read', resource: { type: 'adoc', id: 'x2' } });
          expect(again.allowed).to.equal(false);
          await new Promise((r) => setTimeout(r, 200));
        });
      });
    });
  }
});
