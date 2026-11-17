import { expect } from 'chai';
import 'mocha';
import * as fc from 'fast-check';

import { AuthorizationModel, DecisionLog, PolicyHashSource, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { AuthzTx, DecisionRecord, Permission, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { DbAssignmentStore } from '@spinajs/authz-rbac';
import { AuthzRebac_2026_10_21_00_00_00, DbTupleStore, RebacModel } from '@spinajs/authz-rebac';
import type { NamespaceConfig, Tuple } from '@spinajs/authz-rebac';
import { AUDIT_CONNECTION, AuthzDecisionLogFacts_2026_11_06_00_00_00, AuthzDecisionLog_2026_11_04_00_00_00, DbDecisionLog } from '@spinajs/authz-orm/audit';
import { CHANGE_LOG_TABLE, IRPolicyHashSource } from '@spinajs/authz-orm/changelog';
import { DbDecisionReplay } from '@spinajs/authz-orm/replay';
import { arb, fixtureDsl, replayAgreement, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { HostSetup, OrmModelSpec, ReplayAgreementFixture, ReplayAgreementRun, SetupContext, World } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { e2eHarness } from '../e2e/support/stack.js';
import type { E2eHarness } from '../e2e/support/stack.js';

const { combine, role } = fixtureDsl;

const DOMAIN = 'test';
// Small windows keep the pauses short; a pause longer than the backward side keeps every write outside it whatever the load.
const WINDOW = { clockSkewMs: 10, commitLagMs: 40 };
const PAUSE_MS = 3 * (WINDOW.clockSkewMs + WINDOW.commitLagMs);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CASE: SetupContext = { id: 'B06', part: 'replay', case: 'replayAgreement', title: 'replayAgreement', facets: ['engine', 'host', 'rbac', 'orm'] };

const USERS = ['u0', 'u1', 'u2', 'u3'];
const ROOT: PrincipalRef = { type: 'user', id: 'root' };
const PROJECTS = ['p0', 'p1', 'p2'];
const TASKS = ['t0', 't1', 't2', 't3'];
const SCOPES: readonly ResourceRef[] = [...PROJECTS.map((id) => ({ type: 'project', id })), ...TASKS.map((id) => ({ type: 'task', id }))];
const SCOPE_TYPES = ['project', 'task'];
// The expressible RBAC fragment: plain grants and a deny role, no implies, `on`, ladders or rules. Until v4-z-26 the IR
// carries a deny role down the scope chain only when `$global` is among its scope types.
const ROLES = [
  role('viewer', ['task:read', 'project:read'], { scopeTypes: SCOPE_TYPES }),
  role('editor', ['task:read', 'task:update', 'project:read'], { scopeTypes: SCOPE_TYPES }),
  role('blocked', ['task:update'], { deny: true, scopeTypes: ['$global', ...SCOPE_TYPES] }),
];
const GRAPH = { folderDepth: 2, groupDepth: 1, width: 2, users: USERS };
const CHECKS: readonly (readonly [Permission, string])[] = [
  ['task:read', 'task'],
  ['task:update', 'task'],
  ['project:read', 'project'],
  ['doc:read', 'doc'],
  ['doc:edit', 'doc'],
  ['folder:read', 'folder'],
];

/** The kit's tuple-graph schema as RebacModel namespaces. */
const NAMESPACES: NamespaceConfig = Object.fromEntries(
  Object.entries(arb.TUPLE_GRAPH_SCHEMA).map(([type, ns]) => [
    type,
    {
      relations: Object.fromEntries(Object.entries(ns.relations ?? {}).map(([r, subjects]) => [r, subjects.split('|').map((s) => s.trim())])),
      permissions: Object.fromEntries(Object.entries(ns.permissions ?? {}).map(([p, expr]) => [p, { union: expr.split('|').map((t) => t.trim()) }])),
    },
  ]),
);

const project = fc.constantFrom(...PROJECTS);
const grant = fc.record({ user: fc.constantFrom(...USERS), role: fc.constantFrom(...ROLES.map((r) => r.name)), scope: fc.constantFrom(...SCOPES) });
/** The state before the decisions (tuples[0], parents, grants), the decisions, and the writes after them (tuples[1], moves, revokes, laterGrants). */
const scenarios = fc.record({
  tuples: fc.tuple(arb.tupleGraph(GRAPH), arb.tupleGraph(GRAPH)),
  parents: fc.array(project, { minLength: TASKS.length, maxLength: TASKS.length }),
  moves: fc.array(fc.record({ task: fc.constantFrom(...TASKS), to: project }), { maxLength: 3 }),
  grants: fc.array(fc.record({ grant, revokedLater: fc.boolean() }), { maxLength: 4 }),
  laterGrants: fc.array(grant, { maxLength: 2 }),
  checks: fc.array(fc.record({ user: fc.constantFrom(...USERS), check: fc.constantFrom(...CHECKS), object: fc.nat(99) }), { minLength: 1, maxLength: 6 }),
});
type Scenario = typeof scenarios extends fc.Arbitrary<infer S> ? S : never;
type Grant = Scenario['laterGrants'][number];

const tupleKey = (t: Tuple): string => `${t.object.type}:${t.object.id}#${t.relation}@${JSON.stringify(t.subject)}`;
const minus = (a: readonly Tuple[], b: readonly Tuple[]): Tuple[] => {
  const keys = new Set(b.map(tupleKey));
  return [...new Map(a.filter((t) => !keys.has(tupleKey(t))).map((t) => [tupleKey(t), t])).values()];
};

function world(s: Scenario): World {
  const models: OrmModelSpec[] = [
    { name: 'Project', type: 'project', columns: [], rows: PROJECTS.map((id) => ({ id })) },
    { name: 'Task', type: 'task', parents: [{ column: 'project_id', type: 'project' }], columns: ['project_id'], rows: TASKS.map((id, i) => ({ id, project_id: s.parents.at(i) })) },
  ];
  return {
    now: new Date(),
    permissions: [...new Set(CHECKS.map(([p]) => p))],
    principals: Object.fromEntries(USERS.map((u) => [u, userPrincipal(u)])),
    combine: combine('deny-overrides', 'rbac', 'rebac'),
    rbac: { roles: ROLES, assignments: [] },
    lane: { orm: { models } },
  };
}

/** DbDecisionLog that keeps what the tap handed it. */
class KeptDecisionLog extends DecisionLog {
  readonly records: DecisionRecord[] = [];
  readonly errors: unknown[] = [];
  private readonly db = new DbDecisionLog({ error: (e: unknown) => void this.errors.push(e) });

  async write(records: DecisionRecord[]): Promise<void> {
    this.records.push(...records);
    await this.db.write(records);
  }
}

/** The e2e stack plus the database decision log, a ReBAC model over DbTupleStore and the changelog of every store. */
class Stack implements ReplayAgreementFixture<Scenario> {
  readonly scenarios = scenarios;
  readonly harness: E2eHarness;
  private log = new KeptDecisionLog();
  private captureInputs = false;
  private assignments!: DbAssignmentStore;
  /** Replays that allowed, and replays that read a state from history: a property that saw none of either proves little. */
  readonly seen = { allow: 0, history: 0 };

  constructor() {
    this.harness = e2eHarness('sqlite', { register: (host) => this.register(host) });
  }

  private get driver(): OrmDriver {
    return this.harness.db().driver('sqlite');
  }

  async before(): Promise<void> {
    await this.harness.beforeAll?.();
    this.harness.db().orm.Connections.set(AUDIT_CONNECTION, this.driver);
    for (const m of [new AuthzDecisionLog_2026_11_04_00_00_00(), new AuthzDecisionLogFacts_2026_11_06_00_00_00(), new AuthzRebac_2026_10_21_00_00_00()]) await m.up(this.driver);
    await this.harness.db().orm.reloadTableInfo();
    testHost.config().set(['authz', 'replay'], WINDOW);
    this.assignments = await DI.resolve(DbAssignmentStore);
  }

  async after(): Promise<void> {
    testHost.config().unset(['authz', 'replay']);
    this.harness.db().orm.Connections.delete(AUDIT_CONNECTION);
    await this.harness.afterAll?.();
  }

  private async register(host: HostSetup): Promise<void> {
    const rebac = new RebacModel({ store: new DbTupleStore(), namespaces: NAMESPACES, permissions: arb.TUPLE_GRAPH_PERMISSIONS });
    host.container.register(testHost.named(rebac.name, testHost.instance(rebac))).as(AuthorizationModel);
    const models = ['authz', 'domains', host.domain, 'models'];
    host.setConfig(models, [...(testHost.config().get<string[] | undefined>(models) ?? []), rebac.name]);
    host.container.register(testHost.instance(this.log)).as(DecisionLog);
    host.setConfig(['authz', 'decisionLog'], { mode: 'all', captureInputs: this.captureInputs, batch: { size: 1, flushMs: 1000 } });
  }

  private inTx<R>(fn: (tx: AuthzTx) => Promise<R>): Promise<R> {
    return this.driver.transaction((driver: OrmDriver) => fn({ driver }));
  }

  private assign(g: Grant): Promise<{ id: string }> {
    const store = this.assignments;
    return this.inTx((tx) => store.assign({ subject: { type: 'user', id: g.user }, role: g.role, scope: g.scope }, ROOT, tx));
  }

  async open(s: Scenario, options: { readonly captureInputs: boolean }): Promise<ReplayAgreementRun> {
    this.captureInputs = options.captureInputs;
    this.log = new KeptDecisionLog();
    for (const table of [CHANGE_LOG_TABLE, 'authz_rebac_tuple']) await this.harness.db().raw(`DELETE FROM ${table}`);
    const session = await this.harness.setup(world(s), CASE);
    let open = true;
    const dispose = async () => {
      if (open) await session.dispose();
      open = false;
    };
    try {
      const [before, after] = s.tuples;
      const tuples = new DbTupleStore();
      await tuples.write(minus(before.tuples, []), [], ROOT);
      // Granting what a subject holds already answers the held assignment.
      const revokedLater = new Set<string>();
      for (const g of s.grants) {
        const { id } = await this.assign(g.grant);
        if (g.revokedLater) revokedLater.add(id);
      }
      const hashes = await DI.resolve(PolicyHashSource);
      if (hashes instanceof IRPolicyHashSource) await hashes.current(DOMAIN)?.recorded;
      await pause(PAUSE_MS);
      const ids = (rows: readonly { id: string }[]): string[] => [...new Set(rows.map((r) => r.id))];
      const objects = new Map<string, readonly string[]>([
        ['task', TASKS],
        ['project', PROJECTS],
        ['doc', ids([...before.rows.doc, ...after.rows.doc])],
        ['folder', ids([...before.rows.folder, ...after.rows.folder])],
      ]);
      const { authz, lane } = session;
      if (authz === undefined || lane?.orm === undefined) throw new Error('replayAgreement: the e2e session has no authz or orm lane');
      const orm = lane.orm;
      const log = this.log;

      return {
        decide: async () => {
          for (const c of s.checks) {
            const [permission, type] = c.check;
            const of = objects.get(type) ?? [];
            await authz.check({ principal: userPrincipal(c.user), permission, resource: { type, id: of.at(c.object % of.length) } });
          }
          // The domain's dispose flushes its decision log.
          await dispose();
          if (log.errors.length > 0) throw new Error(`the decision log failed: ${String(log.errors[0])}`);
          return log.records;
        },
        write: async () => {
          await pause(PAUSE_MS);
          for (const { task, to } of s.moves) await runWithPrincipal(SYSTEM, () => orm.run({ op: 'update', model: 'Task', values: { project_id: to }, where: { id: task } }));
          for (const id of revokedLater) await this.inTx((tx) => this.assignments.revoke(id, ROOT, tx));
          for (const g of s.laterGrants) await this.assign(g);
          await tuples.write(minus(after.tuples, before.tuples), minus(before.tuples, after.tuples), ROOT);
        },
        replay: async (id: string) => {
          const report = await new DbDecisionReplay().replay(id);
          if (report?.outcome.replayed === 'allow') this.seen.allow++;
          if (report?.reads.some((r) => r.origin === 'history') === true) this.seen.history++;
          return report;
        },
        dispose,
      };
    } catch (e) {
      await dispose();
      throw e;
    }
  }
}

describe('replayAgreement (P4): engine decisions replay faithfully', function () {
  this.timeout(1_800_000);
  const stack = new Stack();

  before(() => stack.before());
  after(() => stack.after());

  for (const captureInputs of [false, true]) {
    it(`${captureInputs ? 'with' : 'without'} captured inputs: evidence ${captureInputs ? 'inputs-hash' : 'outcome'}`, async () => {
      await replayAgreement({ fixture: stack, captureInputs });
      if ((Number(process.env.AUTHZ_REPLAY_AGREEMENT_RUNS) || 200) >= 50) expect(stack.seen.allow > 0 && stack.seen.history > 0, JSON.stringify(stack.seen)).to.equal(true);
    });
  }
});
