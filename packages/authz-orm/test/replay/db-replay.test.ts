import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, DecisionLogTap, DecisionReplay, ReplayBusy, ScopeForgetter, TRUE, changeLog } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, DecisionRecord, PolicyHashSource, Principal, ReplayReport, ResourceRef } from '@spinajs/authz';
import { HistoryContributors, canonicalize, policyHash } from '@spinajs/authz-ir';
import type { ChangeRecord } from '@spinajs/authz';
import type { CurrentItem, HistoryEdge, ObjectRef, PolicyIR, RelationDef, TupleSubjectRef } from '@spinajs/authz-ir';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { ReplicaRouter } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { AUDIT_CONNECTION, AuthzDecisionLogFacts_2026_11_06_00_00_00, AuthzDecisionLog_2026_11_04_00_00_00, DbDecisionLog } from '../../src/audit/index.js';
import { AccessResource, HorizonRecord, Parent, columnFingerprint, ormToIR, pruneChangeLog, recordCoverage, recordPolicyVersion } from '../../src/index.js';
import { ColumnHistoryContributor, DbDecisionReplay } from '../../src/replay/index.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[]): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> } };
interface Tuple {
  object: ObjectRef;
  relation: string;
  subject: TupleSubjectRef;
}

class NoopForgetter extends ScopeForgetter {
  async forget(_scope: ResourceRef, _ctx: AdminContext, _tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 0, tags: [], events: [] };
  }
}

/** The ReBAC store, stubbed in memory: its rows here, its changes in the database changelog. */
class MemoryTuples extends HistoryContributors {
  static readonly rows = new Map<string, Tuple>();
  readonly kind = 'tuple' as const;

  serves(source: RelationDef['source']): boolean {
    return source.kind === 'tuples' && source.store === 'memory';
  }

  coverageType(): undefined {
    return undefined;
  }

  current(object: ObjectRef, relation: string): Promise<CurrentItem<TupleSubjectRef>[]> {
    const rows = [...MemoryTuples.rows].filter(([, t]) => t.relation === relation && t.object.type === object.type && t.object.id === object.id);
    return Promise.resolve(rows.map(([key, t]) => ({ key, image: t, subject: t.subject })));
  }

  currentReverse(): Promise<CurrentItem<ObjectRef>[]> {
    return Promise.resolve([]);
  }

  edges(c: ChangeRecord): HistoryEdge[] {
    const t = c.payload as Tuple | null;
    return t === null ? [] : [{ key: c.key, ...t }];
  }

  subjectAt(image: unknown): TupleSubjectRef {
    return (image as Tuple).subject;
  }
}

const U1: Principal = { type: 'user', id: 'u1', authenticated: true, source: 'test', attributes: {} };
const VIEWER: Tuple = { object: { type: 'folder', id: 'f1' }, relation: 'viewer', subject: { type: 'user', id: 'u1' } };
const D1 = { type: 'doc', id: 'd1' };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WINDOW = { clockSkewMs: 50, commitLagMs: 200 };

function irOf(Doc: M): PolicyIR {
  const orm = ormToIR({ classes: [Doc] }).reduce<Record<string, RelationDef>>((all, f) => ({ ...all, ...Object.entries(f.types ?? {}).find(([t]) => t === 'doc')?.[1].relations }), {});
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      folder: { relations: { viewer: { allowed: ['user'], source: { kind: 'tuples', store: 'memory' } } }, permissions: {} },
      doc: { relations: orm, permissions: { view: { tupleToUserset: { tupleset: 'parent', computed: 'viewer' } } } },
    },
    permissions: { 'doc:read': { type: 'doc', relation: 'view', list: false, source: { origin: 'test' } } },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

describe('DbDecisionReplay', function () {
  this.timeout(180000);
  let pg = false;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    DI.register(MemoryTuples).as(HistoryContributors);
  });

  after(() => {
    DI.unregister(HistoryContributors, MemoryTuples);
  });

  it('is the registered DecisionReplay', () => {
    expect(DI.getRegisteredTypes(DecisionReplay)).to.include(DbDecisionReplay);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let db: TestDb;
      let driver: OrmDriver;
      let Doc: M;
      let ir: PolicyIR;
      let previous: unknown;

      before(async function () {
        if (dialect === 'postgres' && !pg) return this.skip();
        db = await TestDb.open({ postgres: dialect === 'postgres' });
        driver = db.driver(dialect);
        db.orm.Connections.set(AUDIT_CONNECTION, driver);
        previous = testHost.config().get(['authz', 'replay']);
        testHost.config().set(['authz', 'replay'], WINDOW);
      });

      after(async () => {
        if (!db) return;
        testHost.config().set(['authz', 'replay'], previous);
        db.orm.Connections.delete(AUDIT_CONNECTION);
        await db.close();
      });

      beforeEach(async () => {
        undo.push(testHost.registerInRoot(ScopeForgetter, testHost.instance(new NoopForgetter())));
        await (await testHost.domains()).service('root');
        await createAncestorTable(db, dialect);
        await new AuthzDecisionLog_2026_11_04_00_00_00().up(driver);
        await new AuthzDecisionLogFacts_2026_11_06_00_00_00().up(driver);
        await db.orm.reloadTableInfo();
        MemoryTuples.rows.clear();
      });

      afterEach(async () => {
        sinon.restore();
        await new AuthzDecisionLog_2026_11_04_00_00_00().down(driver);
        await db.clear();
        await dropAncestorTable(db, dialect);
        for (const fn of undo.splice(0).reverse()) fn();
        await testHost.resetRoot();
      });

      /** Doc d1 in folder f1, which u1 views; coverage from an hour ago; the policy stored under its hash. */
      async function world(o: { changelog?: boolean; coverFrom?: Date; store?: boolean } = {}): Promise<void> {
        Doc = (await db.define({ name: 'Doc', columns: { folder_id: 'TEXT' }, decorate: (c, p) => (AccessResource('doc', { changelog: o.changelog ?? true })(c), Parent('folder')(p, 'folder_id')) }, dialect)) as M;
        ir = irOf(Doc);
        await recordCoverage(['tuple'], [{ type: 'doc', fingerprint: columnFingerprint('doc') }], [], o.coverFrom ?? new Date(Date.now() - 3_600_000));
        await Doc.insert({ id: 'd1', folder_id: 'f1' });
        await addTuple(VIEWER);
        if (o.store !== false) await recordPolicyVersion(policyHash(ir), canonicalize(ir));
        await pause(3 * WINDOW.commitLagMs);
      }

      async function addTuple(t: Tuple): Promise<void> {
        const key = `${t.object.type}:${t.object.id}#${t.relation}@${t.subject.type}:${t.subject.id}`;
        MemoryTuples.rows.set(key, t);
        await driver.transaction(() => changeLog().append([{ kind: 'tuple', op: 'add', key, payload: t }]));
      }

      /** Logs u1's decision on doc:d1 through the real tap into the database decision log. */
      async function decide(allowed: boolean, env: Record<string, unknown> = {}): Promise<string> {
        const records: DecisionRecord[] = [];
        const errors: unknown[] = [];
        const sink = new DbDecisionLog({ error: (e: unknown) => void errors.push(e) });
        const policy: PolicyHashSource = { policyHash: () => policyHash(ir) };
        const tap = new DecisionLogTap({ domain: 'root', sink: { write: (r) => (records.push(...r), sink.write(r)) }, mode: 'all', allowSampleRate: 1, captureInputs: false, batch: { size: 1, flushMs: 1000 }, policy, log: { error: () => undefined } });
        const decision = { allowed, permission: 'doc:read', resource: D1, principal: { type: 'user', id: 'u1' }, residual: TRUE, fields: { read: [], write: [] }, roles: {}, domain: 'root' };
        tap.onDecision({ principal: U1, permission: 'doc:read', resource: D1, env }, decision, { env, attributes: [], relations: [], modelVersions: {} }, { cached: false, durationMs: 3 });
        await tap.flush();
        expect(errors).to.deep.equal([]);
        return records[0].id;
      }

      const replay = async (id: string): Promise<ReplayReport> => {
        const report = await new DbDecisionReplay().replay(id);
        if (report === undefined) throw new Error(`no record ${id}`);
        return report;
      };
      const moveAfter = async () => {
        await pause(3 * WINDOW.clockSkewMs);
        await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
      };

      it('1: a doc moved to another folder after the decision replays faithfully from history', async () => {
        await world();
        const id = await decide(true);
        await moveAfter();
        const report = await replay(id);
        expect(report).to.deep.include({ replay: 'faithful', evidence: 'outcome', outcome: { recorded: 'allow', replayed: 'allow' } });
        expect(report.reads.find((r) => r.key === 'doc:d1#parent')).to.deep.include({ kind: 'column', origin: 'history' });
      });

      it('2: a model kept out of the changelog is unreplayable, naming the column kind of its type', async () => {
        await world({ changelog: false });
        const id = await decide(true);
        await moveAfter();
        const report = await replay(id);
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing.map((m) => [m.input, m.key])).to.deep.include(['column', 'column:doc']);
      });

      it('4: a decision before the first coverage boot names where the history starts', async () => {
        await world({ coverFrom: new Date(Date.now() + 60_000) });
        const report = await replay(await decide(true));
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing.some((m) => /history starts at/.test(m.reason))).to.equal(true);
      });

      it('5: retention pruned past the decision makes it unreplayable', async () => {
        await world();
        const id = await decide(true);
        await pruneChangeLog(1, new Date(Date.now() + 2 * 86_400_000));
        expect((await replay(id)).replay).to.equal('unreplayable');
      });

      it('6: no stored policy version names the hash', async () => {
        await world({ store: false });
        const report = await replay(await decide(true));
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing).to.deep.include({ input: 'policy_version', key: policyHash(ir), reason: 'no policy version is stored under the hash' });
      });

      it('7: a write that escaped the column log after the decision makes its type unreplayable', async () => {
        await world();
        const id = await decide(true);
        await pause(3 * WINDOW.clockSkewMs);
        await driver.transaction(() => changeLog().lost('column', 'doc', 'insert without returned ids'));
        const report = await replay(id);
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing.map((m) => m.key)).to.include('column:doc');
      });

      // A set read cannot enumerate a tuple or assignment deleted by raw SQL after T (R1); a column read knows its one key.
      for (const [what, sql] of [
        ['updated', (t: string) => `UPDATE ${t} SET folder_id = 'f2' WHERE id = 'd1'`],
        ['deleted', (t: string) => `DELETE FROM ${t} WHERE id = 'd1'`],
      ] as const) {
        it(`8: a column logged before the decision and ${what} by raw SQL after it is never faithful`, async () => {
          await world();
          const id = await decide(true);
          await db.raw(sql(TestDb.quote(db.table(Doc), dialect)), [], dialect);
          const report = await replay(id);
          expect(report.replay).to.equal('unreplayable');
          expect(report.missing.some((m) => m.key === 'doc:d1#parent' && /outside the changelog/.test(m.reason))).to.equal(true);
        });
      }

      it('10: one replay past authz.replay.concurrency is refused with ReplayBusy', async () => {
        await world();
        const id = await decide(true);
        const replays = new DbDecisionReplay();
        const results = await Promise.allSettled([replays.replay(id), replays.replay(id), replays.replay(id)]);
        expect(results.filter((r) => r.status === 'fulfilled')).to.have.length(2);
        const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(refused?.reason).to.be.instanceOf(ReplayBusy);
      });

      it('refuses to replay inside a transaction open on the authz connection', async () => {
        await world();
        const id = await decide(true);
        const refused = await driver.transaction(() => new DbDecisionReplay().replay(id).then(() => undefined, (e: unknown) => e));
        expect(refused).to.be.instanceOf(AuthzConfigError);
        expect((refused as Error).message).to.match(/inside a transaction/);
        expect((await replay(id)).replay).to.equal('faithful');
      });

      it('11: a caller-supplied env.now far in the past is replayed at loggedAt', async () => {
        await world();
        const id = await decide(true, { now: new Date('2020-01-01T00:00:00.000Z') });
        await moveAfter();
        const report = await replay(id);
        expect(report.decision.at).to.equal('2020-01-01T00:00:00.000Z');
        expect(report).to.deep.include({ replay: 'faithful', outcome: { recorded: 'allow', replayed: 'allow' } });
      });

      it('12: a change inserted before the decision and committed after it is a gap, never divergent', async () => {
        await world();
        let id = '';
        await driver.transaction(async () => {
          await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
          await pause(2 * WINDOW.clockSkewMs);
          id = await decide(true);
        });
        const report = await replay(id);
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing.some((m) => m.key === 'doc:d1#parent' && /ambiguity window/.test(m.reason))).to.equal(true);
      });

      it('13: a re-parent committed between the scan and the current read is resolved from history', async () => {
        await world();
        const id = await decide(true);
        await pause(3 * WINDOW.clockSkewMs);
        const columns = new ColumnHistoryContributor();
        const current = columns.current.bind(columns);
        let raced = false;
        sinon.stub(ColumnHistoryContributor.prototype, 'current').callsFake(async (...args: Parameters<typeof current>) => {
          if (!raced) {
            raced = true;
            await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
          }
          return current(...args);
        });
        const report = await replay(id);
        expect(raced).to.equal(true);
        expect(report).to.deep.include({ replay: 'faithful', outcome: { recorded: 'allow', replayed: 'allow' } });
        expect(report.reads.find((r) => r.key === 'doc:d1#parent')?.origin).to.equal('history');
      });

      it('14: every select of a replay reads the primary, whatever the replica router answers', async () => {
        await world();
        const id = await decide(true);
        const router = DI.resolve(ReplicaRouter);
        sinon.stub(router, 'pick').throws(new Error('a replay select was routed'));
        expect(await HorizonRecord.query().first().then(() => 'read', (e: Error) => e.message)).to.equal('a replay select was routed');
        expect((await replay(id)).replay).to.equal('faithful');
      });

      it('reports a record the log cannot read back as unreplayable, and an unknown id as undefined', async () => {
        await world();
        const id = await decide(true);
        await db.raw(`UPDATE authz_decision_log SET facts = '{not json' WHERE id = '${id}'`, [], dialect);
        const report = await replay(id);
        expect(report).to.deep.include({ replay: 'unreplayable', outcome: { recorded: 'allow', replayed: null } });
        expect(report.missing[0].input).to.equal('record');
        expect(await new DbDecisionReplay().replay('0190c5f0-0000-7000-8000-00000000ffff')).to.equal(undefined);
      });
    });
  }
});
