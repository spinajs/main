import * as chai from 'chai';
import 'mocha';

import { DecisionLogTap, FALSE, PermissionRegistryImpl, TRUE, changeLog } from '@spinajs/authz';
import type { AuthzTx, ChangeLog, DecisionLog, DecisionRecord, PrincipalRef } from '@spinajs/authz';
import { MemoryChangeLog, StoredPolicySplicers, canonicalize, mergeFragments, policyHash, replayDecision, storedPolicyName } from '@spinajs/authz-ir';
import type { PolicyIR, ReplayDeps, StoredPlaceholder } from '@spinajs/authz-ir';
import { CHANGE_LOG_TABLE, recordCoverage } from '@spinajs/authz-orm/changelog';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_POLICY_TABLE, DbPolicyStore, PolicySplicer, abacRelation, abacToIR } from '../src/index.js';
import { DB_KINDS, bootDb, rawQuery } from './support/db.js';
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

  describe('splice', () => {
    const placeholder = (permission: string, side: 'permit' | 'deny'): StoredPlaceholder => ({ model: 'abac', store: 'db', permission, side });
    const known = (value: Record<string, unknown>) => ({ key: String(value.id), state: { known: true, value, origin: 'current' } as const });
    const readOpen = known({ id: 'doc-open', effect: 'permit', permissions: ['doc:read'], when: { attr: 'resource.status', eq: 'open' } });
    const writeAdmin = known({ id: 'doc_open', effect: 'permit', permissions: ['doc:write'], principalTypes: ['admin'] });
    const plain = known({ id: 'plain', effect: 'permit', permissions: ['doc:read'] });

    it('makes policies whose caveat names collide unknown, never one standing in for the other', () => {
      const spliced = new PolicySplicer().splice(placeholder('doc:read', 'permit'), [readOpen, writeAdmin, plain], storedIR(['db']));
      expect(spliced.term).to.deep.equal({ union: [{ intersection: [] }, { opaque: 'abac policy doc-open' }, { opaque: 'abac policy doc_open' }] });
      expect(spliced.caveats).to.not.have.property('abac_doc_open');
    });

    it('makes a policy unknown when its caveat name means something else in the stored IR', () => {
      const ir = storedIR(['db']);
      ir.caveats.abac_doc_open = { params: { 'env.region': 'string' }, expr: { attr: 'env.region', eq: 'eu' } };
      const spliced = new PolicySplicer().splice(placeholder('doc:read', 'permit'), [readOpen, plain], ir);
      expect(spliced.term).to.deep.equal({ union: [{ intersection: [] }, { opaque: 'abac policy doc-open' }] });
      expect(spliced.caveats).to.deep.equal({});
    });

    it('makes a gap or an image that no longer loads unknown on both sides of every permission', () => {
      const items = [plain, { key: 'drift', state: { known: false, reason: 'a write outside the changelog' } as const }, known({ id: 'broken', permissions: ['doc:read'] })];
      const unknown = [{ opaque: 'abac policy drift' }, { opaque: 'abac policy broken' }];
      const splicer = new PolicySplicer();
      const ir = storedIR(['db']);
      expect(splicer.splice(placeholder('doc:read', 'permit'), items, ir).term).to.deep.equal({ union: [{ intersection: [] }, ...unknown] });
      expect(splicer.splice(placeholder('doc:write', 'deny'), items, ir)).to.deep.include({ term: { union: unknown } });
    });

    it('keeps the placeholder when the stored policies do not compile against the IR', () => {
      const items = [plain, known({ id: 'stray', effect: 'permit', permissions: ['invoice:read'] })];
      expect(new PolicySplicer().splice(placeholder('doc:read', 'permit'), items, storedIR(['db']))).to.deep.equal({ term: { opaque: storedPolicyName('abac', 'db') } });
    });
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

      beforeEach(async () => {
        for (const table of [AUTHZ_POLICY_TABLE, CHANGE_LOG_TABLE]) await rawQuery(db.driver, `DELETE FROM ${table}`, [], QueryContext.Delete);
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
        await write((tx) => store.put({ id: 'everyone', effect: 'permit', permissions: ['doc:*'] }, user('root'), tx));
        await write((tx) => store.put({ id: 'locked', effect: 'deny', permissions: ['doc:read'], when: { attr: 'resource.status', eq: 'locked' } }, user('root'), tx));
        await pause(4 * WINDOW);
        const record = await recordOf(ir, 'd3', true);
        await pause(4 * WINDOW);
        const report = await replayDecision(record, depsOf(ir, changeLog()));
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing.map((m) => m.input)).to.include('resource.status');
      });

      it('names a policy whose row was changed outside the store', async () => {
        await write((tx) => store.put({ id: 'everyone', effect: 'permit', permissions: ['doc:*'] }, user('root'), tx));
        await pause(4 * WINDOW);
        const record = await recordOf(ir, 'd4', true);
        await rawQuery(db.driver, `UPDATE ${AUTHZ_POLICY_TABLE} SET reason = ? WHERE id = ?`, ['edited', 'everyone'], QueryContext.Update);
        const report = await replayDecision(record, depsOf(ir, changeLog()));
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing.map((m) => [m.input, m.key])).to.deep.include.members([
          ['policy', 'everyone'],
          ['opaque', 'abac policy everyone'],
        ]);
      });

      it('makes the store a gap when a policy row no longer parses, instead of failing the replay', async () => {
        await write((tx) => store.put({ id: 'everyone', effect: 'permit', permissions: ['doc:*'] }, user('root'), tx));
        await pause(4 * WINDOW);
        const record = await recordOf(ir, 'd5', true);
        await rawQuery(db.driver, `UPDATE ${AUTHZ_POLICY_TABLE} SET permissions = ? WHERE id = ?`, ['{not json', 'everyone'], QueryContext.Update);
        const report = await replayDecision(record, depsOf(ir, changeLog()));
        expect(report.replay).to.equal('unreplayable');
        expect(report.missing.map((m) => [m.input, m.key])).to.deep.include(['policy', 'policy:db']);
      });
    });
  }
});
