import 'mocha';
import { expect } from 'chai';
import type { ChangeRecord, Condition, DecisionRecord, Principal } from '@spinajs/authz';

import { MemoryChangeLog, canonicalize, policyHash, replayDecision } from '../../src/index.js';
import type { KeyState, PolicyIR, ReplayDeps, Rewrite, StoredEdge, StoredPlaceholder, StoredPolicySplicer } from '../../src/index.js';
import { Switches, TupleStore } from '../fixtures/history-store.js';
import { tapped } from '../fixtures/tap.js';

const T = new Date('2026-11-17T12:00:00.000Z');
const ms = (offset: number): Date => new Date(T.getTime() + offset);
const HOUR = 3_600_000;
const editor = (u: string) => ({ object: { type: 'doc', id: 'd1' }, relation: 'editor', subject: { type: 'user', id: u } });

function irOf(edit: Rewrite = { computed: 'editor' }, caveats: PolicyIR['caveats'] = {}): PolicyIR {
  return {
    version: 1,
    types: { user: { relations: {}, permissions: {} }, doc: { relations: { editor: { allowed: ['user'], source: { kind: 'tuples', store: 't' } } }, permissions: { edit } } },
    permissions: { 'doc:edit': { type: 'doc', relation: 'edit', list: false, source: { origin: 'test' } } },
    caveats,
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: true, delegation: true, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

/** Rules of a stored store, logged as kind `rule`; a gap item stays an opaque term named after it. */
class Rules implements StoredPolicySplicer {
  readonly kind = 'rule' as const;
  items: Array<{ key: string; image: unknown }> = [];
  locate(name: string): StoredPlaceholder | undefined {
    return name === 'stored:rbac:db' ? { model: 'rbac', store: 'db', permission: 'doc:edit', side: 'deny' } : undefined;
  }
  current(): Promise<Array<{ key: string; image: unknown }>> {
    return Promise.resolve(this.items);
  }
  edge(c: ChangeRecord): StoredEdge {
    return { store: 'db', key: c.key };
  }
  splice(_at: StoredPlaceholder, items: ReadonlyArray<{ key: string; state: KeyState }>): { term: Rewrite } {
    const gaps = items.filter((i) => !i.state.known).map((i): Rewrite => ({ opaque: `rbac rule ${i.key}` }));
    return { term: gaps.length > 0 ? { union: gaps } : { priority: [] } };
  }
}

interface World {
  log: MemoryChangeLog;
  tuples: TupleStore;
  rules: Rules;
  ir: PolicyIR;
  deps: ReplayDeps;
  record(over?: Partial<DecisionRecord>): DecisionRecord;
}

async function world(ir = irOf(), at = T): Promise<World> {
  const since = new Date(at.getTime() - 2 * HOUR);
  const log = new MemoryChangeLog().cover('tuple', since).cover('rule', since).cover('policy', since);
  const tuples = new TupleStore(log);
  await tuples.add(editor('u1'), new Date(at.getTime() - HOUR));
  const rules = new Rules();
  const policies = new Map([[policyHash(ir), canonicalize(ir)]]);
  const limits = { maxChanges: 1000, maxKeys: 1000, maxDepth: 8, maxCalls: 10_000, clockSkewMs: 1000, commitLagMs: 5000, timeoutMs: 15_000 };
  const deps: ReplayDeps = { log, loadPolicy: (h) => Promise.resolve(policies.get(h)), contributors: [tuples], splicers: [rules], limits, now: () => at.getTime() + HOUR };
  const base: DecisionRecord = { id: '0190c5f0-0000-7000-8000-000000000001', at: at.toISOString(), loggedAt: at.toISOString(), durationMs: 5, domain: 'default', principal: 'user:u1', permission: 'doc:edit', resource: { type: 'doc', id: 'd1' }, allowed: true, cached: false, policyHash: policyHash(ir), modelVersions: {}, inputsHash: 'h', facts: { principal: { type: 'user', id: 'u1' } } };
  return { log, tuples, rules, ir, deps, record: (over = {}) => ({ ...base, ...over }) };
}

const user = (attributes: Record<string, unknown> = {}): Principal => ({ type: 'user', id: 'u1', authenticated: true, source: 'test', attributes });

describe('replayDecision', function () {
  this.timeout(30_000);

  it('replays an allow faithfully after the tuple it read was removed', async () => {
    const w = await world();
    await w.tuples.remove(editor('u1'), ms(HOUR / 2));
    const report = await replayDecision(w.record(), w.deps);
    expect(report).to.deep.include({ replay: 'faithful', evidence: 'outcome', currentPolicy: false, outcome: { recorded: 'allow', replayed: 'allow' } });
    expect(report.reads).to.deep.include({ kind: 'tuple', key: 'doc:d1#editor@user:u1', origin: 'history', seq: 2 });
    expect(report.inputsHash).to.deep.equal({ recorded: 'h', replayed: null });
    expect(report.decision).to.not.have.any.keys('facts', 'inputs');
    expect((await replayDecision(w.record(), { ...w.deps, currentPolicyHash: () => policyHash(w.ir) })).currentPolicy).to.equal(true);
  });

  it('a recorded allow the history shows impossible is divergent', async () => {
    const w = await world();
    const report = await replayDecision(w.record({ principal: 'user:u2', facts: { principal: { type: 'user', id: 'u2' } } }), w.deps);
    expect(report.replay).to.equal('divergent');
    expect(report.divergence).to.deep.equal([{ part: 'outcome', recorded: 'allow', replayed: 'deny' }]);
  });

  it('names the policy version it cannot load, and divergent when the stored IR hashes elsewhere', async () => {
    const w = await world();
    expect((await replayDecision(w.record({ policyHash: 'unknown' }), w.deps)).missing).to.deep.equal([{ input: 'policy_version', key: 'unknown', reason: 'the decision was logged without a policy hash' }]);
    const missing = await replayDecision(w.record({ policyHash: 'f'.repeat(64) }), w.deps);
    expect(missing).to.deep.include({ replay: 'unreplayable', tree: null });
    expect(missing.missing[0]).to.include({ input: 'policy_version', key: 'f'.repeat(64) });
    const other = irOf({ union: [] });
    const forged = await replayDecision(w.record(), { ...w.deps, loadPolicy: () => Promise.resolve(canonicalize(other)) });
    expect(forged.divergence).to.deep.equal([{ part: 'policy-hash', recorded: policyHash(w.ir), replayed: policyHash(other) }]);
  });

  it('refuses what the IR does not model (rule 1)', async () => {
    const w = await world();
    const cases: Array<[Partial<DecisionRecord>, string]> = [
      [{ facts: { principal: { type: 'user', id: 'u1', companions: ['user:u9'] } } }, 'principal.companions'],
      [{ resource: { type: 'doc' } }, 'resource'],
      [{ reason: 'model_error', allowed: false }, 'reason'],
      [{ principal: 'system:system', facts: { principal: { type: 'system', id: 'system' } } }, 'principal'],
      [{ facts: undefined }, 'principal-facts'],
      [{ at: 'not a date' }, 'record'],
    ];
    for (const [over, input] of cases) {
      const report = await replayDecision(w.record(over), w.deps);
      expect(report.replay, input).to.equal('unreplayable');
      expect(report.missing.map((m) => m.input), input).to.include(input);
    }
    expect((await replayDecision(w.record(), w.deps, { truncated: ['resource'] })).missing).to.deep.equal([{ input: 'record', key: 'resource', reason: 'the logged resource key was cut to its column width' }]);
  });

  it('refuses an actor caveat when the actor is not the principal', async () => {
    const w = await world(irOf({ caveat: 'agentless', of: { computed: 'editor' } }, { agentless: { params: {}, expr: { attr: 'actor.type', eq: 'user' } } }));
    const report = await replayDecision(w.record({ actor: 'agent:a1' }), w.deps);
    expect(report.missing).to.deep.equal([{ input: 'actor', key: 'agentless', reason: 'the IR reads actor.* as the principal' }]);
  });

  it('names an app condition function and parameters the record does not hold', async () => {
    const fn: Condition = { fn: 'app.inOffice' };
    const w = await world(irOf({ caveat: 'office', of: { computed: 'editor' } }, { office: { params: {}, expr: { all: [fn, { attr: 'env.hour', gte: 9 }] } } }));
    const report = await replayDecision(w.record(), w.deps);
    expect(report.replay).to.equal('unreplayable');
    expect(report.missing).to.deep.include({ input: 'condition-function', key: 'app.inOffice', reason: 'app condition functions are unknown at the decision instant' });
    expect(report.missing).to.deep.include({ input: 'env.hour', key: 'office', reason: 'inputs are captured only with authz.decisionLog.captureInputs' });
  });

  it('a caveat value its conditional tuple supplies is held; a request value beside it is not', async () => {
    const conditional = (expr: Condition): PolicyIR => {
      const ir = irOf({ computed: 'editor' }, { draft: { params: {}, expr } });
      ir.types.doc.relations.editor.allowed = [{ type: 'user', caveat: 'draft' }];
      return ir;
    };
    const tuple = { ...editor('u1'), subject: { type: 'user', id: 'u1', caveat: { name: 'draft', context: { 'resource.status': 'draft' } } } };
    const conditionalOnly = async (w: World): Promise<void> => {
      await w.tuples.remove(editor('u1'), ms(-HOUR / 2));
      await w.tuples.add(tuple, ms(-HOUR / 4));
    };
    const held = await world(conditional({ attr: 'resource.status', eq: 'draft' }));
    await conditionalOnly(held);
    const faithful = await replayDecision(held.record(), held.deps);
    expect(faithful).to.deep.include({ replay: 'faithful', outcome: { recorded: 'allow', replayed: 'allow' } });

    const mixed = await world(conditional({ all: [{ attr: 'resource.status', eq: 'draft' }, { attr: 'env.region', eq: 'eu' }] }));
    await conditionalOnly(mixed);
    const report = await replayDecision(mixed.record(), mixed.deps);
    expect(report.replay).to.equal('unreplayable');
    expect(report.missing.map((m) => m.input)).to.include('env.region').and.not.include('resource.status');
  });

  it('a caveat over a parameter the replay lacks is unknown even where the evaluator would decide it', async () => {
    const w = await world(irOf({ caveat: 'open', of: { computed: 'editor' } }, { open: { params: {}, expr: { not: { attr: 'resource.status', eq: 'frozen' } } } }));
    const report = await replayDecision(w.record(), w.deps);
    expect(report.replay).to.equal('unreplayable');
    expect(report.missing.map((m) => m.input)).to.include('resource.status');
  });

  describe('stored switches', () => {
    const u9 = { principal: 'user:u9', facts: { principal: { type: 'user', id: 'u9' } } };
    async function switched(): Promise<World & { switches: Switches }> {
      const ir = irOf({ union: [{ computed: 'editor' }, { opaque: 'stored:abac:a' }] });
      ir.types.doc.permissions.other = { opaque: 'stored:abac:c' };
      ir.permissions['doc:other'] = { type: 'doc', relation: 'other', list: false, source: { origin: 'test' } };
      const w = await world(ir);
      const switches = new Switches(w.log);
      w.deps = { ...w.deps, splicers: [switches] };
      return { ...w, switches };
    }

    it('a store takes only its own items, whatever other stores of the kind held at T', async () => {
      const w = await switched();
      await w.switches.set('rb', { store: 'b', open: true }, ms(-HOUR));
      await w.switches.set('rb', undefined, ms(HOUR / 2));
      const report = await replayDecision(w.record({ ...u9, allowed: false }), w.deps);
      expect(report).to.deep.include({ replay: 'faithful', outcome: { recorded: 'deny', replayed: 'deny' } });
    });

    it('splices an item as it was at T, not as a later write left it', async () => {
      const w = await switched();
      await w.switches.set('ra', { store: 'a', open: true }, ms(-HOUR));
      await w.switches.set('ra', { store: 'a', open: false }, ms(HOUR / 2));
      const report = await replayDecision(w.record(u9), w.deps);
      expect(report).to.deep.include({ replay: 'faithful', outcome: { recorded: 'allow', replayed: 'allow' } });
      expect(report.reads).to.deep.include({ kind: 'policy', key: 'ra', origin: 'history', seq: 3 });
    });

    it('splices only the placeholders the decision can reach', async () => {
      const w = await switched();
      await w.switches.set('rc', { store: 'c', open: true }, ms(-HOUR));
      const report = await replayDecision(w.record({ ...u9, allowed: false }), w.deps);
      expect(report.replay).to.equal('faithful');
      expect(report.reads.map((r) => r.key)).to.not.include('rc');
    });
  });

  it('splices stored items: none at T replays an allow faithfully, a gap item stays opaque and is named', async () => {
    const w = await world(irOf({ exclusion: { base: { computed: 'editor' }, subtract: { opaque: 'stored:rbac:db' } } }));
    expect((await replayDecision(w.record(), w.deps)).replay).to.equal('faithful');
    await w.log.append([{ kind: 'rule', op: 'add', key: 'r1', payload: { id: 'r1', v: 1 }, at: ms(-HOUR) }]);
    w.rules.items = [{ key: 'r1', image: { id: 'r1', v: 2 } }];
    const report = await replayDecision(w.record(), w.deps);
    expect(report.replay).to.equal('unreplayable');
    expect(report.missing).to.deep.include({ input: 'opaque', key: 'rbac rule r1', reason: 'the IR cannot see it' });
    expect(report.missing.map((m) => `${m.input}:${m.key}`)).to.include('rule:r1');
    const unspliced = await replayDecision(w.record(), { ...w.deps, splicers: [] });
    expect(unspliced.missing).to.deep.include({ input: 'opaque', key: 'stored:rbac:db', reason: 'the IR cannot see it' });
  });

  it('maps the history budget and the timeout to unreplayable, and rethrows a cancel', async () => {
    const w = await world();
    await w.tuples.remove(editor('u1'), ms(HOUR / 2));
    await w.tuples.add(editor('u2'), ms(HOUR / 2));
    const budget = await replayDecision(w.record(), w.deps, { maxChanges: 1 });
    expect(budget).to.deep.include({ replay: 'unreplayable', limits: { changes: 2, maxChanges: 1, keys: 0, durationMs: budget.limits.durationMs } });
    expect(budget.missing[0]).to.include({ input: 'history-budget', key: 'maxChanges' });
    w.log.beforeRead = (m) => (m === 'latest' ? new Promise((resolve) => setTimeout(resolve, 50)) : undefined);
    const late = await replayDecision(w.record(), { ...w.deps, limits: { ...w.deps.limits, timeoutMs: 10 } });
    expect(late.missing).to.deep.equal([{ input: 'timeout', reason: 'the replay ran past timeoutMs 10' }]);
    const cancelled = new AbortController();
    cancelled.abort(new Error('client went away'));
    const error = await replayDecision(w.record(), w.deps, { signal: cancelled.signal }).catch((e: unknown) => e);
    expect(error).to.be.instanceOf(Error).with.property('message', 'client went away');
  });

  it('decodes the tagged capture and re-hashes it: env.ip == null is faithful', async () => {
    const ir = irOf({ caveat: 'local', of: { computed: 'editor' } }, { local: { params: {}, expr: { attr: 'env.ip', null: true } } });
    const record = await tapped(ir, user(), { ip: undefined, n: Number.NaN }, true);
    expect(record.inputs?.env).to.deep.equal({ ip: '<undefined>', n: '<number:NaN>' });
    const w = await world(ir, new Date(record.loggedAt!));
    const report = await replayDecision(record, w.deps);
    expect(report).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash' });
    expect(report.inputsHash).to.deep.equal({ recorded: record.inputsHash, replayed: record.inputsHash });
    const tampered = { ...record, inputs: { ...record.inputs!, env: { ...record.inputs!.env, n: 1 } } };
    expect((await replayDecision(tampered, w.deps)).divergence.map((d) => d.part)).to.deep.equal(['inputs-hash']);
  });

  it('a captured value the tags cannot restore is unknown, and principal attributes come from the principal state', async () => {
    const ir = irOf({ caveat: 'big', of: { computed: 'editor' } }, { big: { params: {}, expr: { attr: 'env.n', eq: 1 } } });
    const record = await tapped(ir, user(), { n: 1n }, false);
    const w = await world(ir, new Date(record.loggedAt!));
    const big = await replayDecision(record, w.deps);
    expect(big.replay).to.equal('unreplayable');
    expect(big.missing.map((m) => m.input)).to.include('env.n');
    const dept = irOf({ caveat: 'sales', of: { computed: 'editor' } }, { sales: { params: {}, expr: { attr: 'principal.attributes.$dept', eq: 'sales' } } });
    const withDept = await tapped(dept, user({ $dept: 'sales' }), {}, true);
    expect(await replayDecision(withDept, (await world(dept, new Date(withDept.loggedAt!))).deps)).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash' });
  });
});
