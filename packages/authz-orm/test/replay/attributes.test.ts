import * as chai from 'chai';
import 'mocha';

import { DecisionLogTap, ScopeForgetter, TRUE, resourceKey } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, DecisionRecord, PolicyHashSource, Principal, ReplayReport, ResourceRef } from '@spinajs/authz';
import { AttributeHistoryContributors, canonicalize, policyHash } from '@spinajs/authz-ir';
import type { PolicyIR } from '@spinajs/authz-ir';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { AUDIT_CONNECTION, AuthzDecisionLogFacts_2026_11_06_00_00_00, AuthzDecisionLog_2026_11_04_00_00_00, DbDecisionLog } from '../../src/audit/index.js';
import { AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore, SCOPE_ATTRIBUTE_TABLE, SCOPE_ATTRIBUTE_VERSION_TABLE, recordCoverage, recordPolicyVersion } from '../../src/index.js';
import { DbDecisionReplay, ScopeAttributeHistoryContributor } from '../../src/replay/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createChangeLogTables, dropChangeLogTables } from '../support/changelog.js';

const expect = chai.expect;

class NoopForgetter extends ScopeForgetter {
  async forget(_scope: ResourceRef, _ctx: AdminContext, _tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 0, tags: [], events: [] };
  }
}

const U1: Principal = { type: 'user', id: 'u1', authenticated: true, source: 'test', attributes: {} };
const ALICE = { type: 'user', id: 'alice' };
const D1 = { type: 'doc', id: 'd1' };
const ORG: ResourceRef = { type: 'org', id: 'o1' };
// 64 + 64 + 160 characters: the plain key `type:id#path` passes the 255 of authz_change_log.key.
const WIDE: ResourceRef = { type: 't'.repeat(64), id: 'i'.repeat(64) };
const WIDE_PATH = 'p'.repeat(160);
const WINDOW = { clockSkewMs: 50, commitLagMs: 200 };
// Past the window on every dialect, PGlite's whole-second changelog instants included.
const AFTER_MS = 1200;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `doc:read` for everyone whose decision saw `scope.<type>.<path>` equal `value`. */
function irOf(scope: ResourceRef, path: string, value: unknown): PolicyIR {
  return {
    version: 1,
    types: { user: { relations: {}, permissions: {} }, doc: { relations: {}, permissions: { view: { caveat: 'scoped', of: { intersection: [] } } } } },
    permissions: { 'doc:read': { type: 'doc', relation: 'view', list: false, source: { origin: 'test' } } },
    caveats: { scoped: { params: {}, expr: { attr: `scope.${scope.type}.${path}`, eq: value } } },
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

describe('DbDecisionReplay: captured scope attributes', function () {
  this.timeout(240000);
  let db: TestDb;
  const reachable = new Set<Dialect>(['sqlite', 'pglite']);
  const undo: (() => void)[] = [];
  const store = new DbScopeAttributeStore();

  before(async () => {
    if (await TestDb.postgresReachable()) reachable.add('postgres');
    if (await TestDb.mysqlReachable()) reachable.add('mysql');
    db = await TestDb.open({ postgres: reachable.has('postgres'), pglite: true, mysql: reachable.has('mysql') });
  });

  after(async () => {
    await db?.close();
  });

  it('registers the scope attribute contributor', () => {
    const all = DI.resolve(Array.ofType(AttributeHistoryContributors)).filter((c) => c instanceof ScopeAttributeHistoryContributor);
    expect(all.map((c) => c.kind)).to.deep.equal(['attribute']);
  });

  for (const dialect of ['sqlite', 'pglite', 'postgres', 'mysql'] as const) {
    describe(dialect, () => {
      let driver: OrmDriver;
      let previous: unknown;
      // support/scope-attributes.ts quotes with '"', which MySQL reads as a string.
      const dropAttributeTables = async () => {
        for (const t of [SCOPE_ATTRIBUTE_VERSION_TABLE, SCOPE_ATTRIBUTE_TABLE]) await db.raw(`DROP TABLE IF EXISTS ${TestDb.quote(t, dialect)}`, [], dialect);
      };

      before(function () {
        if (!reachable.has(dialect)) return this.skip();
        driver = db.driver(dialect);
        db.orm.Connections.set(AUDIT_CONNECTION, driver);
        previous = testHost.config().get(['authz', 'replay']);
        testHost.config().set(['authz', 'replay'], WINDOW);
      });

      after(() => {
        if (!reachable.has(dialect)) return;
        testHost.config().set(['authz', 'replay'], previous);
        db.orm.Connections.delete(AUDIT_CONNECTION);
      });

      beforeEach(async () => {
        undo.push(testHost.registerInRoot(ScopeForgetter, testHost.instance(new NoopForgetter())));
        await (await testHost.domains()).service('root');
        await dropAttributeTables();
        await new AuthzScopeAttribute_2026_10_02_00_00_00().up(driver);
        await createChangeLogTables(db, dialect);
        await new AuthzDecisionLog_2026_11_04_00_00_00().up(driver);
        await new AuthzDecisionLogFacts_2026_11_06_00_00_00().up(driver);
        await db.orm.reloadTableInfo();
      });

      afterEach(async () => {
        await new AuthzDecisionLog_2026_11_04_00_00_00().down(driver);
        await dropAttributeTables();
        await dropChangeLogTables(db, dialect);
        for (const fn of undo.splice(0).reverse()) fn();
        await testHost.resetRoot();
      });

      const write = (scope: ResourceRef, set: Record<string, string | number>) => driver.transaction((d) => store.write(scope, { set, remove: [] }, ALICE, { driver: d }));
      const table = () => TestDb.quote(SCOPE_ATTRIBUTE_TABLE, dialect);

      /** The policy stored, attributes covered from an hour ago, then `setup` well before the decision. */
      async function world(ir: PolicyIR, o: { covered?: boolean } = {}): Promise<void> {
        if (o.covered !== false) await recordCoverage(['attribute'], [], [], new Date(Date.now() - 3_600_000));
        await recordPolicyVersion(policyHash(ir), canonicalize(ir));
      }

      /** u1's allowed decision on doc:d1, logged with `captureInputs` over the node `scope` as the store holds it now. */
      async function decide(ir: PolicyIR, scope: ResourceRef): Promise<string> {
        await pause(3 * WINDOW.commitLagMs);
        const node = await store.get(scope);
        const records: DecisionRecord[] = [];
        const errors: unknown[] = [];
        const sink = new DbDecisionLog({ error: (e: unknown) => void errors.push(e) });
        const policy: PolicyHashSource = { policyHash: () => policyHash(ir) };
        const tap = new DecisionLogTap({ domain: 'root', sink: { write: (r) => (records.push(...r), sink.write(r)) }, mode: 'all', allowSampleRate: 1, captureInputs: true, batch: { size: 1, flushMs: 1000 }, policy, log: { error: () => undefined } });
        const decision = { allowed: true, permission: 'doc:read', resource: D1, principal: { type: 'user', id: 'u1' }, residual: TRUE, fields: { read: [], write: [] }, roles: {}, domain: 'root' };
        tap.onDecision({ principal: U1, permission: 'doc:read', resource: D1, env: {} }, decision, { env: {}, attributes: [{ ref: scope, path: '', value: node }], relations: [], modelVersions: {} }, { cached: false, durationMs: 3 });
        await tap.flush();
        expect(errors).to.deep.equal([]);
        await pause(AFTER_MS);
        return records[0].id;
      }

      const replay = async (id: string): Promise<ReplayReport> => {
        const report = await new DbDecisionReplay().replay(id);
        if (report === undefined) throw new Error(`no record ${id}`);
        return report;
      };
      const attributeReads = (r: ReplayReport) => r.reads.filter((x) => x.kind === 'attribute');

      it('a: an attribute changed through the store after the decision replays faithfully from history', async () => {
        const ir = irOf(ORG, 'level', 2);
        await world(ir);
        await write(ORG, { level: 2 });
        const id = await decide(ir, ORG);
        await write(ORG, { level: 1 });
        const report = await replay(id);
        expect(report).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash', divergence: [] });
        expect(attributeReads(report).map((r) => r.origin)).to.deep.equal(['history']);
      });

      it('b: an attribute without logged history changed by raw SQL after the decision is divergent captured-state', async () => {
        const ir = irOf(ORG, 'level', 2);
        await world(ir);
        await driver.insert().into(SCOPE_ATTRIBUTE_TABLE).values({ scope_type: 'org', scope_id: 'o1', path: 'level', value_json: '2', value_text: '2', value_num: 2, updated_by: 'sql', updated_at: new Date() });
        const id = await decide(ir, ORG);
        await db.raw(`UPDATE ${table()} SET value_json = '1', value_text = '1', value_num = 1 WHERE path = 'level'`, [], dialect);
        const report = await replay(id);
        expect(report.replay).to.equal('divergent');
        expect(report.outcome).to.deep.equal({ recorded: 'allow', replayed: 'allow' });
        expect(report.divergence).to.deep.equal([{ part: 'captured-state', key: 'org:o1#level', recorded: '2', replayed: '1' }]);
      });

      it('b: an attribute with logged history changed by raw SQL after the decision is a gap, which leaves the verdict', async () => {
        const ir = irOf(ORG, 'level', 2);
        await world(ir);
        await write(ORG, { level: 2 });
        const id = await decide(ir, ORG);
        await db.raw(`UPDATE ${table()} SET value_json = '1', value_text = '1', value_num = 1 WHERE path = 'level'`, [], dialect);
        const report = await replay(id);
        expect(report).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash', divergence: [] });
        expect(attributeReads(report)[0]).to.deep.include({ origin: 'gap' });
        expect(attributeReads(report)[0].reason).to.match(/outside the changelog/);
      });

      it('c: a leaf whose plain key passes 255 characters round-trips under its hashed key', async () => {
        expect(`${resourceKey(WIDE)}#${WIDE_PATH}`.length).to.be.greaterThan(255);
        const ir = irOf(WIDE, WIDE_PATH, 'gold');
        await world(ir);
        await write(WIDE, { [WIDE_PATH]: 'gold' });
        const id = await decide(ir, WIDE);
        await write(WIDE, { [WIDE_PATH]: 'silver' });
        const report = await replay(id);
        expect(report).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash', divergence: [] });
        expect(attributeReads(report).map((r) => r.origin)).to.deep.equal(['history']);
      });

      it('an app without attribute coverage or table replays without reading the store', async () => {
        const ir = irOf(ORG, 'level', 2);
        await world(ir, { covered: false });
        await write(ORG, { level: 2 });
        const id = await decide(ir, ORG);
        await db.raw(`DROP TABLE ${table()}`, [], dialect);
        const report = await replay(id);
        expect(report).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash', divergence: [] });
        expect(attributeReads(report)).to.deep.equal([{ kind: 'attribute', key: 'org:o1', origin: 'gap', reason: 'the attribute history starts nowhere (not covered)' }]);
      });
    });
  }
});
