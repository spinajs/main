import * as chai from 'chai';
import 'mocha';

import { DecisionLog, DecisionLogTap, TRUE, inputsHashOf, resourceKey } from '@spinajs/authz';
import type { DecisionRecord, HostLog, Principal } from '@spinajs/authz';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import { renderTemplate } from '@spinajs/log-common';
import { DI } from '@spinajs/di';
import { MIGRATION_DESCRIPTION_SYMBOL } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { IContainer } from '@spinajs/di';

import { AUDIT_CONNECTION, AuthzDecisionLogFacts_2026_11_06_00_00_00, AuthzDecisionLog_2026_11_04_00_00_00, DECISION_LOG_TABLE, DbDecisionLog, readDecisionRecord } from '../src/audit/index.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };

type Row = Record<string, unknown> & { id: string; at: unknown; allowed: unknown; cached: unknown };

const recordingLog = () => {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (fields: unknown, template?: unknown) => void lines.push({ level, message: typeof fields === 'string' ? fields : renderTemplate(template as string, fields as Record<string, unknown>) });
  const log: HostLog = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
  return { log, lines };
};

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6a',
  at: '2026-11-04T10:00:00.000Z',
  domain: 'root',
  principal: 'user:alice',
  permission: 'doc:read',
  resource: { type: 'doc', id: 'd1' },
  allowed: false,
  reason: 'no_access',
  cached: false,
  policyHash: 'unknown',
  modelVersions: { rbac: 'v1' },
  inputsHash: 'a'.repeat(64),
  ...over,
});

// Postgres returns booleans, SQLite 0/1.
const bool = (v: unknown): boolean => v === true || v === 1;

describe('authz-orm DbDecisionLog', function () {
  this.timeout(120000);
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
  });

  it('the migrations are registered for the authz-audit connection', () => {
    for (const m of [AuthzDecisionLog_2026_11_04_00_00_00, AuthzDecisionLogFacts_2026_11_06_00_00_00]) {
      expect(DI.getRegisteredTypes('__migrations__')).to.include(m);
      expect((m as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal(AUDIT_CONNECTION);
    }
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let db: TestDb;
      let driver: OrmDriver;
      const migration = new AuthzDecisionLog_2026_11_04_00_00_00();
      const facts = new AuthzDecisionLogFacts_2026_11_06_00_00_00();

      const rows = async (): Promise<Row[]> => (await db.raw(`SELECT * FROM ${DECISION_LOG_TABLE} ORDER BY id`, [], dialect)) as Row[];
      const reset = async () => {
        await migration.down(driver);
        await migration.up(driver);
        await facts.up(driver);
        await db.orm.reloadTableInfo();
      };

      before(async function () {
        if (dialect === 'postgres' && !pg) return this.skip();
        db = await TestDb.open({ postgres: dialect === 'postgres' });
        driver = db.driver(dialect);
        db.orm.Connections.set(AUDIT_CONNECTION, driver);
      });

      after(async () => {
        if (!db) return;
        await migration.down(driver);
        db.orm.Connections.delete(AUDIT_CONNECTION);
        await db.close();
      });

      it('the migration creates authz_decision_log with its columns; down drops it', async () => {
        await migration.up(driver);
        const columns = (await driver.tableInfo(DECISION_LOG_TABLE, driver.Options.Database)).map((c) => [c.Name, c.Nullable]);
        expect(Object.fromEntries(columns)).to.deep.equal({
          id: false,
          at: false,
          trace_id: true,
          span_id: true,
          domain: false,
          principal: false,
          actor: true,
          permission: false,
          resource: false,
          allowed: false,
          reason: true,
          cached: false,
          policy_hash: false,
          model_versions: true,
          inputs_hash: false,
          inputs: true,
        });
        await migration.down(driver);
        expect(await driver.schema().tableExists(DECISION_LOG_TABLE)).to.equal(false);
      });

      it('writes a batch in one go, one row per record, inputs only when captured', async () => {
        await reset();
        const { log, lines } = recordingLog();
        const sink = new DbDecisionLog(log);
        const inputs = { env: { ip: "1.2.3.4'; --" }, attributes: [], relations: [], modelVersions: {}, principalState: null, actorState: null };
        await sink.write([
          record(),
          record({ id: '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6b', allowed: true, reason: undefined, cached: true, actor: 'agent:bot', traceId: 't'.repeat(32), spanId: 's'.repeat(16), inputs }),
        ]);
        expect(lines).to.deep.equal([]);
        const [denied, allowed] = await rows();
        expect(denied).to.include({ domain: 'root', principal: 'user:alice', actor: null, permission: 'doc:read', resource: 'doc:d1', reason: 'no_access', policy_hash: 'unknown', inputs_hash: 'a'.repeat(64), inputs: null, trace_id: null });
        expect([bool(denied.allowed), bool(denied.cached)]).to.deep.equal([false, false]);
        expect(JSON.parse(denied.model_versions as string)).to.deep.equal({ rbac: 'v1' });
        expect(allowed).to.include({ actor: 'agent:bot', reason: null, trace_id: 't'.repeat(32), span_id: 's'.repeat(16) });
        expect([bool(allowed.allowed), bool(allowed.cached)]).to.deep.equal([true, true]);
        expect(JSON.parse(allowed.inputs as string)).to.deep.equal(inputs);
      });

      it("as the domain's DecisionLog: a denial writes a row under the decision's id", async () => {
        await reset();
        const undo: (() => void)[] = [];
        const setConfig = (path: string[], value: unknown) => {
          const config = testHost.config();
          const prev = config.get<unknown>(path);
          config.set(path, value);
          undo.push(() => (prev === undefined ? config.unset(path) : config.set(path, prev)));
        };
        const ds = await testHost.domains();
        const name = `dlog${dialect}`;
        setConfig(['authz', 'domains', name], { permissions: { 'ldoc:read': { types: ['ldoc'] } }, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 } });
        setConfig(['authz', 'decisionLog'], { batch: { size: 1 } });
        const container: IContainer = ds.create(name, 'root');
        try {
          testHost.activate(container, name, new StaticModel({ name: 'm1', votes: {} }));
          container.register(DbDecisionLog).as(DecisionLog);
          const denied = await (await ds.service(name)).check({ principal: alice, permission: 'ldoc:read', resource: { type: 'ldoc', id: 'x1' } });
          for (let i = 0; i < 100 && (await rows()).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
          const all = await rows();
          expect(all.map((r) => [r.id, r.domain, r.permission, r.resource])).to.deep.equal([[denied.id, name, 'ldoc:read', 'ldoc:x1']]);
        } finally {
          await container.dispose();
          for (const fn of undo.reverse()) fn();
        }
      });

      it('the facts migration adds nullable facts, logged_at and duration_ms; down drops them', async () => {
        await migration.down(driver);
        await migration.up(driver);
        await facts.up(driver);
        const columns = async () => Object.fromEntries((await driver.tableInfo(DECISION_LOG_TABLE, driver.Options.Database)).map((c) => [c.Name, c.Nullable]));
        expect(await columns()).to.include({ facts: true, logged_at: true, duration_ms: true });
        await facts.down(driver);
        expect(Object.keys(await columns())).to.not.include.members(['facts', 'logged_at', 'duration_ms']);
      });

      it('reads a written record back from the primary, with its facts, instant and duration', async () => {
        await reset();
        const full = record({
          id: '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6c',
          actor: 'agent:bot',
          traceId: 't'.repeat(32),
          spanId: 's'.repeat(16),
          loggedAt: '2026-11-04T10:00:01.000Z',
          durationMs: 12,
          facts: { principal: { type: 'user', id: 'alice', ceiling: { permissions: ['doc:read'] } }, actor: { type: 'agent', id: 'bot', onBehalfOf: { type: 'user', id: 'alice' } } },
          inputs: { env: { ip: '1.2.3.4' }, attributes: [], relations: [], modelVersions: {}, principalState: '{"type":"user"}', actorState: null },
          resource: { type: 'a:b', id: 'x:y/z' },
        });
        await new DbDecisionLog().write([full, record({ id: '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6d', durationMs: 0.4 })]);
        expect(await readDecisionRecord(full.id)).to.deep.equal({ record: full, truncated: [] });
        expect((await readDecisionRecord('0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6d'))?.record).to.deep.equal(record({ id: '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6d', durationMs: 1 }));
        expect(await readDecisionRecord('0192f0c4-7a10-7c3e-9b2a-000000000000')).to.equal(undefined);
      });

      it('a captured record read back re-hashes to its inputsHash, with undefined, NaN and a bigint in env', async () => {
        await reset();
        let captured: DecisionRecord | undefined;
        class Keep extends DecisionLog {
          write(records: DecisionRecord[]): Promise<void> {
            captured = records[0];
            return Promise.resolve();
          }
        }
        const tap = new DecisionLogTap({ domain: 'root', sink: new Keep(), mode: 'all', allowSampleRate: 0, captureInputs: true, batch: { size: 1, flushMs: 60_000 }, log: recordingLog().log });
        const resource = { type: 'doc', id: 'd1' };
        const reads = { env: { ip: undefined, score: Number.NaN, big: 10n, at: new Date('2026-11-04T10:00:00.123Z') }, attributes: [{ ref: resource, path: 'a', value: [undefined, Number.POSITIVE_INFINITY] }], relations: [], modelVersions: { m: 'v1' } };
        const decision = { allowed: true, permission: 'doc:read', resource, principal: alice, residual: TRUE, fields: { read: [], write: [] }, roles: {}, domain: 'root', id: '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b6e' };
        tap.onDecision({ principal: alice, permission: 'doc:read', resource }, decision, reads, { cached: false, durationMs: 1 });
        await tap.flush();
        await new DbDecisionLog().write([captured!]);
        const { record: back } = (await readDecisionRecord(captured!.id))!;
        const parts = { principal: back.inputs!.principalState, actor: back.inputs!.actorState, permission: back.permission, resource: resourceKey(back.resource), env: back.inputs!.env, attributes: back.inputs!.attributes, relations: back.inputs!.relations, modelVersions: back.modelVersions, policyHash: back.policyHash };
        expect(back.inputsHash).to.equal(captured!.inputsHash);
        expect(inputsHashOf(parts)).to.equal(back.inputsHash);
      });

      it('reports the keys the log truncated', async () => {
        await reset();
        const long = record({ resource: { type: 'doc', id: 'x'.repeat(300) }, principal: `user:${'p'.repeat(200)}` });
        await new DbDecisionLog().write([long]);
        const read = await readDecisionRecord(long.id);
        expect(read?.truncated).to.deep.equal(['principal', 'resource']);
        expect(read?.record.resource).to.deep.equal({ type: 'doc', id: 'x'.repeat(251) });
      });

      it('a failing database never rejects: the batch is logged and dropped', async () => {
        await reset();
        const { log, lines } = recordingLog();
        await migration.down(driver);
        await new DbDecisionLog(log).write([record()]);
        expect(lines.map((l) => l.level)).to.deep.equal(['error']);
        expect(lines[0].message).to.match(/writing 1 record\(s\) to authz_decision_log failed, they are dropped/);
      });
    });
  }
});
