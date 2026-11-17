import * as chai from 'chai';
import 'mocha';

import { DecisionLogTap, FALSE, PermissionRegistryImpl, TRUE, changeLog } from '@spinajs/authz';
import type { AuthzTx, ChangeLog, DecisionLog, DecisionRecord, PrincipalRef } from '@spinajs/authz';
import { MemoryChangeLog, StoredPolicySplicers, canonicalize, mergeFragments, policyHash, replayDecision, storedPolicyName } from '@spinajs/authz-ir';
import type { PolicyIR, ReplayDeps } from '@spinajs/authz-ir';
import { recordCoverage } from '@spinajs/authz-orm/changelog';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { DbPolicyStore, PolicySplicer, abacRelation, abacToIR } from '../src/index.js';
import { DB_KINDS, bootDb } from './support/db.js';
import type { TestDb } from './support/db.js';

const expect = chai.expect;

const WINDOW = 100;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const user = (id: string): PrincipalRef => ({ type: 'user', id });

/** The ABAC model's IR when `stores` hold its policies, as `AbacModel.toIR` compiles it with `stored: 'opaque'`. */
function storedIR(stores: readonly string[]): PolicyIR {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'doc:read' }, { name: 'doc:write' }], 'test');
  registry.freeze();
  return mergeFragments([abacToIR([], registry, { storedStores: stores })]).ir;
}

/** The record the tap writes for an allowed or denied `doc:read` of `doc:<id>` under `ir`. */
async function recordOf(ir: PolicyIR, id: string, allowed: boolean): Promise<DecisionRecord> {
  const out: DecisionRecord[] = [];
  const sink: DecisionLog = { write: (r) => Promise.resolve(void out.push(...r)) };
  const tap = new DecisionLogTap({ domain: 'default', sink, mode: 'all', allowSampleRate: 1, captureInputs: false, batch: { size: 1, flushMs: 1000 }, policy: { policyHash: () => policyHash(ir) }, log: { error: () => undefined } });
  const resource = { type: 'doc', id };
  const decision = { allowed, permission: 'doc:read', resource, principal: user('ann'), residual: allowed ? TRUE : FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'default' };
  tap.onDecision({ principal: { ...user('ann'), authenticated: true, source: 'test', attributes: {} }, permission: 'doc:read', resource, env: {} }, decision, { env: {}, attributes: [], relations: [], modelVersions: {} }, { cached: false, durationMs: 3 });
  await tap.flush();
  return out[0];
}

const depsOf = (ir: PolicyIR, log: ChangeLog): ReplayDeps => ({
  log,
  loadPolicy: (h) => Promise.resolve(h === policyHash(ir) ? canonicalize(ir) : undefined),
  contributors: [],
  splicers: [new PolicySplicer()],
  limits: { maxChanges: 1000, maxKeys: 1000, maxDepth: 8, maxCalls: 10_000, clockSkewMs: 50, commitLagMs: WINDOW, timeoutMs: 15_000 },
});

describe('PolicySplicer', function () {
  this.timeout(180000);

  it('is registered as a stored-policy splicer and locates a store in the permit and deny relations of each permission', () => {
    expect(DI.getRegisteredTypes(StoredPolicySplicers)).to.include(PolicySplicer);
    const ir = storedIR(['db']);
    const name = storedPolicyName('abac', 'db');
    for (const permission of ['doc:read', 'doc:write']) {
      for (const side of ['permit', 'deny'] as const) {
        expect(ir.types.doc.permissions[abacRelation(side, permission)]).to.deep.equal({ opaque: name });
        expect(new PolicySplicer().locate(name, 'doc', abacRelation(side, permission), ir)).to.deep.equal({ model: 'abac', store: 'db', permission, side });
      }
    }
    expect(new PolicySplicer().locate(name, 'doc', 'perm_doc_read', ir)).to.equal(undefined);
    expect(new PolicySplicer().locate('abac scope of policy p', 'doc', abacRelation('permit', 'doc:read'), ir)).to.equal(undefined);
  });

  it('leaves a store without a changelog unreplayable, naming the policy kind', async () => {
    const ir = storedIR(['memory']);
    const record = await recordOf(ir, 'm1', true);
    const uncovered = await replayDecision(record, depsOf(ir, new MemoryChangeLog()));
    expect(uncovered.replay).to.equal('unreplayable');
    expect(uncovered.missing.map((m) => [m.input, m.key])).to.deep.include(['policy', 'policy:memory']);

    const covered = await replayDecision(record, depsOf(ir, new MemoryChangeLog().cover('policy', new Date(0))));
    expect(covered.replay).to.equal('unreplayable');
    expect(covered.missing.map((m) => [m.input, m.key])).to.deep.include(['opaque', storedPolicyName('abac', 'memory')]);
  });

  for (const kind of DB_KINDS) {
    describe(kind, () => {
      let db: TestDb;
      const store = new DbPolicyStore();
      const ir = storedIR(['db']);
      const write = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => db.driver.transaction((driver: OrmDriver) => fn({ driver }));

      before(async function () {
        db = await bootDb(this, kind, 'policy_replay');
        await recordCoverage(['policy'], [], [], new Date(Date.now() - 3_600_000));
      });

      after(async () => {
        await db?.dispose();
      });

      it('replays a deny faithfully when a permit policy is added after it, and an allow when its policy is removed after it', async () => {
        await write((tx) => store.put({ id: 'readers', effect: 'permit', permissions: ['doc:read'], resourceTypes: ['doc'] }, user('root'), tx));
        await write((tx) => store.put({ id: 'writers', effect: 'permit', permissions: ['doc:write'] }, user('root'), tx));
        await pause(4 * WINDOW);
        const allowed = await recordOf(ir, 'd1', true);
        await pause(4 * WINDOW);
        await write((tx) => store.delete('readers', tx));
        await pause(4 * WINDOW);
        const denied = await recordOf(ir, 'd2', false);
        await pause(4 * WINDOW);
        await write((tx) => store.put({ id: 'everyone', effect: 'permit', permissions: ['doc:*'] }, user('root'), tx));

        const early = await replayDecision(allowed, depsOf(ir, changeLog()));
        expect(early).to.deep.include({ replay: 'faithful', outcome: { recorded: 'allow', replayed: 'allow' } });
        expect(early.reads.filter((r) => r.kind === 'policy').map((r) => [r.key, r.origin])).to.have.deep.members([
          ['everyone', 'history'],
          ['readers', 'history'],
          ['writers', 'current'],
        ]);
        expect(await replayDecision(denied, depsOf(ir, changeLog()))).to.deep.include({ replay: 'faithful', outcome: { recorded: 'deny', replayed: 'deny' } });
        expect((await replayDecision({ ...denied, allowed: true }, depsOf(ir, changeLog()))).replay).to.equal('divergent');
      });

      it('leaves the replay undecided when a conditional deny policy live at T reads an input the record does not hold', async () => {
        await write((tx) => store.put({ id: 'locked', effect: 'deny', permissions: ['doc:read'], when: { attr: 'resource.status', eq: 'locked' } }, user('root'), tx));
        await pause(4 * WINDOW);
        const record = await recordOf(ir, 'd3', true);
        await pause(4 * WINDOW);
        const report = await replayDecision(record, depsOf(ir, changeLog()));
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing.map((m) => m.input)).to.include('resource.status');
      });
    });
  }
});
