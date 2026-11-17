import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';
import sinon from 'sinon';

import { DecisionLogTap, FALSE, GLOBAL, TRUE, changeLog } from '@spinajs/authz';
import type { AuthzTx, DecisionLog, DecisionReadSet, DecisionRecord, PrincipalRef } from '@spinajs/authz';
import { GLOBAL_OBJECT, GLOBAL_TYPE, HistoricalTupleSource, HistoryContributors, ReplayHistory, canonicalize, policyHash, replayDecision } from '@spinajs/authz-ir';
import type { ObjectRef, PolicyIR, ReplayDeps, Rewrite, TupleSubjectRef } from '@spinajs/authz-ir';
import { recordCoverage } from '@spinajs/authz-orm/changelog';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { AssignmentHistoryContributor, DbAssignmentStore } from '../src/index.js';
import { ALL_DB_KINDS, DB_KINDS, bootDb } from './support/db.js';
import type { Dialect, TestDb } from './support/db.js';

const expect = chai.expect;

const WINDOW = 100;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A whole second ahead of the wall clock: the frozen Date of an expiry case, after the coverage the suites record. */
const frozenStart = (): number => Math.ceil(Date.now() / 1000) * 1000 + 1000;
const source = { kind: 'tuples', store: 'authz_assignment' } as const;
const user = (id: string): PrincipalRef => ({ type: 'user', id });
const G1_MEMBERS = { set: { role: 'member', scope: { type: 'group', id: 'g1' } } };

function irOf(permissions: Record<string, Rewrite> = {}, caveats: PolicyIR['caveats'] = {}): PolicyIR {
  return {
    version: 1,
    types: {
      [GLOBAL_TYPE]: { relations: { admin: { allowed: ['user'], source } }, permissions: {} },
      project: { relations: { editor: { allowed: ['user', 'group#member'], source } }, permissions },
      group: { relations: { member: { allowed: ['user'], source } }, permissions: {} },
    },
    permissions: Object.fromEntries(Object.keys(permissions).map((p) => [`project:${p}`, { type: 'project', relation: p, list: false, source: { origin: 'test' } }])),
    caveats,
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

const label = (s: TupleSubjectRef | ObjectRef): string => `${s.type}:${s.id}${'relation' in s && s.relation !== undefined ? `#${s.relation}` : ''}`;

async function collect<T extends TupleSubjectRef | ObjectRef>(it: AsyncIterable<T>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of it) out.push(label(s));
  return out.sort();
}

describe('AssignmentHistoryContributor', function () {
  this.timeout(180000);

  it('is registered as the history contributor of the assignment kind', () => {
    expect(DI.getRegisteredTypes(HistoryContributors)).to.include(AssignmentHistoryContributor);
    expect(new AssignmentHistoryContributor().serves(source)).to.equal(true);
    expect(new AssignmentHistoryContributor().serves({ kind: 'tuples', store: 'authz_rebac_tuple' })).to.equal(false);
  });

  for (const kind of ALL_DB_KINDS) {
    describe(kind, () => {
      let db: TestDb<Dialect>;
      let store: DbAssignmentStore;
      const inTx = <R>(fn: (tx: AuthzTx) => Promise<R>): Promise<R> => db.driver.transaction((driver: OrmDriver) => fn({ driver }));
      const assign = (subject: PrincipalRef | typeof G1_MEMBERS, role: string, scope: { type: string; id?: string }, expiresAt?: Date, tags: string[] = []) =>
        inTx((tx) => store.assign({ subject, role, scope, tags, ...(expiresAt === undefined ? {} : { expiresAt }) }, user('root'), tx));

      before(async function () {
        db = await bootDb(this, kind, 'rbac_replay');
        store = db.container.resolve(DbAssignmentStore);
        await recordCoverage(['assignment'], [], [], new Date(Date.now() - 3_600_000));
      });

      after(async () => {
        await db?.dispose();
      });

      it('rebuilds role relations at T from current rows and the changelog, expiry and null kept apart, without a gap', async () => {
        // Every instant comes from the frozen Date, so no expiry depends on how long the writes take.
        const start = frozenStart();
        const clock = sinon.useFakeTimers({ now: start, toFake: ['Date'] });
        try {
          await expiryAroundT(start, clock);
        } finally {
          clock.restore();
        }
      });

      async function expiryAroundT(start: number, clock: sinon.SinonFakeTimers): Promise<void> {
        const numeric = '42';
        const uuid = randomUUID();
        // An instant with milliseconds: the store column must keep them, or the history would not match the row.
        const aliceUntil = new Date(start + 2537);
        await assign(user('alice'), 'editor', { type: 'project', id: 'p1' }, aliceUntil);
        const bob = await assign(user('bob'), 'editor', { type: 'project', id: numeric }, undefined, ['x']);
        const set = await assign(G1_MEMBERS, 'editor', { type: 'project', id: 'p1' });
        const member = await assign(user('alice'), 'member', { type: 'group', id: 'g1' });
        const carol = await assign(user('carol'), 'admin', GLOBAL);
        const dave = await assign(user('dave'), 'editor', { type: 'project', id: 'p1' }, new Date(start + 40));
        const erin = await assign(user(uuid), 'editor', { type: 'project', id: uuid });
        await inTx((tx) => store.revoke(erin.id, user('root'), tx));
        await inTx((tx) => store.setTags(bob.id, ['y'], tx));
        clock.tick(3 * WINDOW);
        const T = new Date();
        clock.tick(3 * WINDOW);

        const reads = async () => {
          const history = await ReplayHistory.load(changeLog(), T, ['assignment'], { maxChanges: 1000, maxKeys: 1000, window: { beforeMs: WINDOW, afterMs: WINDOW } });
          const s = new HistoricalTupleSource(irOf(), T, [new AssignmentHistoryContributor()], history);
          const out = {
            p1: await collect(s.read({ type: 'project', id: 'p1' }, 'editor')),
            numeric: await collect(s.read({ type: 'project', id: numeric }, 'editor')),
            uuid: await collect(s.read({ type: 'project', id: uuid }, 'editor')),
            admin: await collect(s.read(GLOBAL_OBJECT, 'admin')),
            g1: await collect(s.read({ type: 'group', id: 'g1' }, 'member')),
            alice: await collect(s.reverse(user('alice'), 'editor', 'project')),
            set: await collect(s.reverse({ type: 'group', id: 'g1', relation: 'member' }, 'editor', 'project')),
            carol: await collect(s.reverse(user('carol'), 'admin', GLOBAL_TYPE)),
          };
          return { out, reads: s.reads };
        };
        const atT = { p1: ['group:g1#member', 'user:alice'], numeric: ['user:bob'], uuid: [], admin: ['user:carol'], g1: ['user:alice'], alice: ['project:p1'], set: ['project:p1'], carol: ['$global:$global'] };
        expect((await reads()).out).to.deep.equal(atT);

        await inTx((tx) => store.setExpiry(bob.id, new Date(Date.now() + 12_345), tx));
        await inTx((tx) => store.revoke(set.id, user('root'), tx));
        await inTx((tx) => store.revoke(carol.id, user('root'), tx));
        await assign(user('carol'), 'admin', GLOBAL, new Date(Date.now() + 60_000));
        await assign(user('frank'), 'editor', { type: 'project', id: 'p1' });
        await inTx((tx) => store.update(member.id, { tags: ['z'] }, user('root'), tx));
        await inTx((tx) => store.revoke(dave.id, user('root'), tx));
        // Alice's assignment has expired by now and was live at T: the current read must keep expired rows.
        clock.setSystemTime(aliceUntil.getTime() + WINDOW);

        const replayed = await reads();
        expect(replayed.out).to.deep.equal(atT);
        expect(replayed.reads.filter((r) => r.origin === 'gap')).to.deep.equal([]);
        expect(replayed.reads.filter((r) => r.origin === 'history').map((r) => r.key)).to.include.members([bob.id, set.id, carol.id, member.id, dave.id]);
      }
    });
  }
});

describe('replay of RBAC decisions end to end (scenarios 3 and 9)', function () {
  this.timeout(180000);

  for (const kind of DB_KINDS) {
    describe(kind, () => {
      let db: TestDb<Dialect>;
      let store: DbAssignmentStore;
      const inTx = <R>(fn: (tx: AuthzTx) => Promise<R>): Promise<R> => db.driver.transaction((driver: OrmDriver) => fn({ driver }));

      before(async function () {
        db = await bootDb(this, kind, 'rbac_replay_e2e');
        store = db.container.resolve(DbAssignmentStore);
        await recordCoverage(['assignment'], [], [], new Date(Date.now() - 3_600_000));
      });

      after(async () => {
        await db?.dispose();
      });

      const ir = irOf({ edit: { computed: 'editor' }, publish: { caveat: 'published', of: { computed: 'editor' } } }, { published: { params: {}, expr: { attr: 'scope.project.status', eq: 'published' } } });
      const deps = (): ReplayDeps => ({
        log: changeLog(),
        loadPolicy: (h) => Promise.resolve(h === policyHash(ir) ? canonicalize(ir) : undefined),
        contributors: [new AssignmentHistoryContributor()],
        splicers: [],
        limits: { maxChanges: 1000, maxKeys: 1000, maxDepth: 8, maxCalls: 10_000, clockSkewMs: 50, commitLagMs: WINDOW, timeoutMs: 15_000 },
      });

      /** The record the real tap writes for u's decision on `project:<id>`. */
      async function decide(u: string, permission: string, id: string, allowed: boolean, captureInputs = false, attributes: DecisionReadSet['attributes'] = [], env: Record<string, unknown> = {}): Promise<DecisionRecord> {
        const out: DecisionRecord[] = [];
        const sink: DecisionLog = { write: (r) => Promise.resolve(void out.push(...r)) };
        const tap = new DecisionLogTap({ domain: 'default', sink, mode: 'all', allowSampleRate: 1, captureInputs, batch: { size: 1, flushMs: 1000 }, policy: { policyHash: () => policyHash(ir) }, log: { error: () => undefined } });
        const resource = { type: 'project', id };
        const decision = { allowed, permission, resource, principal: user(u), residual: allowed ? TRUE : FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'default' };
        tap.onDecision({ principal: { ...user(u), authenticated: true, source: 'test', attributes: {} }, permission, resource, env }, decision, { env, attributes, relations: [], modelVersions: {} }, { cached: false, durationMs: 3 });
        await tap.flush();
        return out[0];
      }

      it('9: an assignment that expired after the decision still allows it, one expired before it denies it', async () => {
        // The decisions are logged at a frozen instant between the two expiries, however long the writes take.
        const start = frozenStart();
        const clock = sinon.useFakeTimers({ now: start, toFake: ['Date'] });
        try {
          const until = new Date(start + 1500);
          await inTx((tx) => store.assign({ subject: user('ann'), role: 'editor', scope: { type: 'project', id: 'e1' }, expiresAt: until }, user('root'), tx));
          const benUntil = new Date(start + 50);
          await inTx((tx) => store.assign({ subject: user('ben'), role: 'editor', scope: { type: 'project', id: 'e2' }, expiresAt: benUntil }, user('root'), tx));
          clock.tick(4 * WINDOW);
          const allowed = await decide('ann', 'project:edit', 'e1', true);
          const denied = await decide('ben', 'project:edit', 'e2', false);
          // The engine judges expiry at the caller's env.now, the record's `at`, over the rows as they were when logged.
          const asOf = await decide('ben', 'project:edit', 'e2', true, false, [], { now: new Date(benUntil.getTime() - 10) });
          clock.setSystemTime(until.getTime() + WINDOW);
          expect(await replayDecision(allowed, deps())).to.deep.include({ replay: 'faithful', outcome: { recorded: 'allow', replayed: 'allow' } });
          expect(await replayDecision(denied, deps())).to.deep.include({ replay: 'faithful', outcome: { recorded: 'deny', replayed: 'deny' } });
          expect(await replayDecision(asOf, deps())).to.deep.include({ replay: 'faithful', outcome: { recorded: 'allow', replayed: 'allow' } });
          const flipped = await replayDecision({ ...denied, allowed: true }, deps());
          expect(flipped.replay).to.equal('divergent');
        } finally {
          clock.restore();
        }
      });

      it('3: a caveat over a captured scope attribute replays by the inputs hash; without the capture it is unreplayable, naming it', async () => {
        await inTx((tx) => store.assign({ subject: user('cid'), role: 'editor', scope: { type: 'project', id: 's1' } }, user('root'), tx));
        await pause(4 * WINDOW);
        const read = [{ ref: { type: 'project', id: 's1' }, path: '', value: { status: 'published' } }];
        const captured = await decide('cid', 'project:publish', 's1', true, true, read);
        const blind = await decide('cid', 'project:publish', 's1', true, false, read);
        await pause(4 * WINDOW);
        expect(await replayDecision(captured, deps())).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash' });
        const report = await replayDecision(blind, deps());
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing.map((m) => m.input)).to.include('scope.project.status');
      });
    });
  }
});
