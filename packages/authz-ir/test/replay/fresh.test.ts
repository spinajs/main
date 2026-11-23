import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';
import type { Condition, Principal } from '@spinajs/authz';

import { IREvaluator, MemoryChangeLog, MemoryTupleSource, canonicalize, policyHash, replayDecision } from '../../src/index.js';
import type { PolicyIR, PrincipalFacts, Rewrite } from '../../src/index.js';
import { CANDIDATES, irAndTuples } from './arbitraries.js';
import type { World } from './arbitraries.js';
import { Switches, TupleStore, tupleKey } from '../fixtures/history-store.js';
import type { Tuple } from '../fixtures/history-store.js';
import { tapped } from '../fixtures/tap.js';

const HOUR = 3_600_000;
const D1 = { type: 'doc', id: 'd1' };
const PLACEHOLDER = { opaque: 'stored:abac:s' };
const SALES: Condition = { any: [{ attr: 'principal.attributes.dept', eq: 'sales' }, { attr: 'env.hour', gte: 9 }] };
const LIMITS = { maxChanges: 1000, maxKeys: 1000, maxDepth: 8, maxCalls: 10_000, clockSkewMs: 1000, commitLagMs: 5000, timeoutMs: 15_000 };

interface Fresh {
  w: World;
  caveat: boolean;
  dept: string;
  hour: number;
  delegate?: { id: string; delegation: 'intersect' | 'inherit' };
  /** User editors are conditional tuples whose context supplies `resource.status`. */
  status?: 'draft' | 'frozen';
  /** A stored switch the view also grants through, open or closed at T. */
  stored?: boolean;
}

/** The fragment the IR expresses exactly: the rewrites and ceilings of `irAndTuples`, delegation, and a caveat over captured inputs. */
function expressibleWorld(): fc.Arbitrary<Fresh> {
  const delegate = fc.option(fc.record({ id: fc.constantFrom('u1', 'u2'), delegation: fc.constantFrom('intersect' as const, 'inherit' as const) }), { nil: undefined });
  const status = fc.option(fc.constantFrom('draft' as const, 'frozen' as const), { nil: undefined });
  return fc.record({ w: irAndTuples(), caveat: fc.boolean(), dept: fc.constantFrom('sales', 'ops'), hour: fc.constantFrom(8, 10), delegate, status, stored: fc.option(fc.boolean(), { nil: undefined }) });
}

/** Grants and revocations of candidate tuples, and flips of the stored switch. */
const writesAfter = (): fc.Arbitrary<Array<{ tuple: number; add: boolean; flip: boolean }>> => fc.array(fc.record({ tuple: fc.integer({ min: 0, max: CANDIDATES.length - 1 }), add: fc.boolean(), flip: fc.boolean() }), { maxLength: 8 });

const conditional = (f: Fresh, t: Tuple): Tuple => (f.status !== undefined && t.relation === 'editor' && t.subject.type === 'user' && t.subject.relation === undefined ? { ...t, subject: { ...t.subject, caveat: { name: 'draft', context: { 'resource.status': f.status } } } } : t);

/** The stored IR with the placeholder replaced as the splice replaces it: what the decision ran on. */
const liveIR = (ir: PolicyIR, open: boolean): PolicyIR => JSON.parse(JSON.stringify(ir).replace(JSON.stringify(PLACEHOLDER), JSON.stringify(open ? { intersection: [] } : { priority: [] }))) as PolicyIR;

/** As the policy version store holds it: canonical, so union and intersection operands are evaluated in the stored order. */
function irOf(f: Fresh, captured: boolean): PolicyIR {
  const ir = structuredClone(f.w.ir);
  ir.principal.delegation = true;
  // Without captured inputs a caveat over them is unknown at T by design, so the property draws it only with them.
  if (captured && f.caveat) {
    ir.caveats.sales = { params: { 'principal.attributes.dept': 'string', 'env.hour': 'int' }, expr: SALES };
    ir.types.doc.permissions.view = { intersection: [ir.types.doc.permissions.view, { caveat: 'sales', of: { intersection: [] } }] };
  }
  if (f.status !== undefined) {
    ir.caveats.draft = { params: { 'resource.status': 'string' }, expr: { attr: 'resource.status', eq: 'draft' } };
    ir.types.doc.relations.editor.allowed.push({ type: 'user', caveat: 'draft' });
  }
  if (f.stored !== undefined) ir.types.doc.permissions.view = { union: [ir.types.doc.permissions.view, PLACEHOLDER] } satisfies Rewrite;
  return JSON.parse(canonicalize(ir)) as PolicyIR;
}

function principalOf(f: Fresh): { principal: Principal; facts: PrincipalFacts } {
  const user = (id: string) => ({ type: 'user', id, authenticated: true, source: 'test', attributes: { dept: f.dept } });
  const ceiling = f.w.principal.ceiling;
  const delegate = f.delegate === undefined ? {} : { onBehalfOf: user(f.delegate.id), delegation: f.delegate.delegation };
  const principal: Principal = { ...user(f.w.principal.id), ...(ceiling?.resources === undefined ? {} : { ceiling: { resources: ceiling.resources } }), ...delegate };
  const facts: PrincipalFacts = {
    type: 'user',
    id: f.w.principal.id,
    attributes: { dept: f.dept },
    ...(ceiling === undefined ? {} : { ceiling }),
    ...(f.delegate === undefined ? {} : { onBehalfOf: { type: 'user', id: f.delegate.id, attributes: { dept: f.dept } }, delegation: f.delegate.delegation }),
  };
  return { principal, facts };
}

describe('replay property P3', function () {
  this.timeout(120_000);

  // P3: a decision logged now and replayed after arbitrary later writes is faithful.
  it('replays a freshly logged decision faithfully after later writes', async () => {
    await fc.assert(
      fc.asyncProperty(expressibleWorld(), writesAfter(), fc.boolean(), async (f, later, captured) => {
        const ir = irOf(f, captured);
        const live = liveIR(ir, f.stored === true);
        const tuples = f.w.tuples.map((t) => conditional(f, t)).sort((a, b) => (tupleKey(a) < tupleKey(b) ? -1 : 1));
        const memory = new MemoryTupleSource(live);
        for (const t of tuples) memory.add(t.object, t.relation, t.subject);
        const { principal, facts } = principalOf(f);
        const { truth, tree } = await new IREvaluator(live, memory).check({ principal: facts, permission: 'doc:view', resource: D1, context: { env: { hour: f.hour } } });
        fc.pre(truth !== 'unknown');

        const record = await tapped(ir, principal, { hour: f.hour }, truth === 'allow', { permission: 'doc:view', captureInputs: captured });
        const t = Date.parse(record.loggedAt!);
        const log = new MemoryChangeLog().cover('tuple', new Date(t - 2 * HOUR)).cover('policy', new Date(t - 2 * HOUR));
        const store = new TupleStore(log);
        const switches = new Switches(log);
        for (const x of tuples) await store.add(x, new Date(t - HOUR));
        let open = f.stored === true;
        await switches.set('k', { store: 's', open }, new Date(t - HOUR));
        for (const [i, w] of later.entries()) {
          const at = new Date(t + LIMITS.clockSkewMs + 1 + i);
          await (w.add ? store.add(conditional(f, CANDIDATES[w.tuple]), at) : store.remove(CANDIDATES[w.tuple], at));
          if (w.flip) await switches.set('k', { store: 's', open: (open = !open) }, at);
        }

        const report = await replayDecision(record, { log, loadPolicy: (h) => Promise.resolve(h === policyHash(ir) ? canonicalize(ir) : undefined), contributors: [store], splicers: [switches], limits: LIMITS, now: () => t + HOUR });
        expect(report.replay, JSON.stringify({ missing: report.missing, divergence: report.divergence })).to.equal('faithful');
        expect(report.evidence).to.equal(captured ? 'inputs-hash' : 'outcome');
        expect(report.outcome.replayed).to.equal(truth);
        expect(report.tree).to.deep.equal(tree);
      }),
      { numRuns: 300 },
    );
  });
});
