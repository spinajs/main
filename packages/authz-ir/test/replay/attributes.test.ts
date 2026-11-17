import 'mocha';
import { expect } from 'chai';
import { resourceKey } from '@spinajs/authz';
import type { DecisionRecord, Principal, ResourceRef } from '@spinajs/authz';

import { MemoryChangeLog, canonicalize, policyHash, replayDecision } from '../../src/index.js';
import type { AttributeHistoryContributor, AttributeLeafImage, PolicyIR, ReplayDeps } from '../../src/index.js';
import { TupleStore } from '../fixtures/history-store.js';
import { tapped } from '../fixtures/tap.js';

const HOUR = 3_600_000;
const ORG: ResourceRef = { type: 'org', id: 'o1' };
const editor = (u: string) => ({ object: { type: 'doc', id: 'd1' }, relation: 'editor', subject: { type: 'user', id: u } });
const user = (id = 'u1'): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {} });

/** Edit needs an editor of a doc whose org has `level` 2 or more. */
const IR: PolicyIR = {
  version: 1,
  types: { user: { relations: {}, permissions: {} }, doc: { relations: { editor: { allowed: ['user'], source: { kind: 'tuples', store: 't' } } }, permissions: { edit: { caveat: 'senior', of: { computed: 'editor' } } } } },
  permissions: { 'doc:edit': { type: 'doc', relation: 'edit', list: false, source: { origin: 'test' } } },
  caveats: { senior: { params: {}, expr: { attr: 'scope.org.level', gte: 2 } } },
  combine: { default: { algorithm: 'deny-overrides' } },
  principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
  opaque: [],
};

/** A scope attribute store keyed by the plain `scope#path`; `raw` writes outside the changelog. */
class Attributes implements AttributeHistoryContributor {
  readonly kind = 'attribute' as const;
  readonly rows = new Map<string, AttributeLeafImage>();

  constructor(private readonly log: MemoryChangeLog) {}

  key(scope: ResourceRef, path: string): string {
    return `${resourceKey(scope)}#${path}`;
  }

  current(scope: ResourceRef): Promise<AttributeLeafImage[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.scope === resourceKey(scope)));
  }

  async set(path: string, value: unknown, at: Date): Promise<void> {
    const key = this.key(ORG, path);
    const old = this.rows.get(key);
    const image = { scope: resourceKey(ORG), path, value };
    this.rows.set(key, image);
    await this.log.append([{ kind: 'attribute', op: old === undefined ? 'add' : 'put', key, payload: image, ...(old === undefined ? {} : { before: old }), at }]);
  }

  raw(path: string, value: unknown): void {
    this.rows.set(this.key(ORG, path), { scope: resourceKey(ORG), path, value });
  }
}

interface World {
  t: Date;
  log: MemoryChangeLog;
  record: DecisionRecord;
  attributes: Attributes;
  deps: ReplayDeps;
}

/** A decision logged now that captured `node` as org:o1, u1 an editor since an hour before it. */
async function world(node: Record<string, unknown>, o: { principal?: string; allowed?: boolean; covered?: boolean; captureInputs?: boolean } = {}): Promise<World> {
  const record = await tapped(IR, user(o.principal), {}, o.allowed ?? true, { attributes: [{ ref: ORG, path: '', value: node }], captureInputs: o.captureInputs ?? true });
  const t = new Date(record.loggedAt!);
  const since = new Date(t.getTime() - 2 * HOUR);
  const log = new MemoryChangeLog().cover('tuple', since);
  if (o.covered !== false) log.cover('attribute', since);
  const tuples = new TupleStore(log);
  await tuples.add(editor('u1'), new Date(t.getTime() - HOUR));
  const attributes = new Attributes(log);
  const limits = { maxChanges: 1000, maxKeys: 1000, maxDepth: 8, maxCalls: 10_000, clockSkewMs: 1000, commitLagMs: 5000, timeoutMs: 15_000 };
  const policies = new Map([[policyHash(IR), canonicalize(IR)]]);
  const deps: ReplayDeps = { log, loadPolicy: (h) => Promise.resolve(policies.get(h)), contributors: [tuples], splicers: [], attributes, limits, now: () => t.getTime() + HOUR };
  return { t, log, record, attributes, deps };
}

const at = (w: World, offset: number): Date => new Date(w.t.getTime() + offset);
const attributeReads = (r: Awaited<ReturnType<typeof replayDecision>>) => r.reads.filter((x) => x.kind === 'attribute');

describe('replayDecision: captured scope attributes (rule 6)', function () {
  this.timeout(30_000);

  it('a captured value the history rebuilds equal is faithful on the inputs hash, though it changed since', async () => {
    const w = await world({ level: 2, region: 'eu' });
    await w.attributes.set('level', 2, at(w, -HOUR));
    await w.attributes.set('level', 3, at(w, HOUR / 2));
    const report = await replayDecision(w.record, w.deps);
    expect(report).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash', divergence: [] });
    expect(attributeReads(report)).to.deep.equal([{ kind: 'attribute', key: 'org:o1#level', origin: 'history', seq: 3 }]);
  });

  it('a known value at T that differs from the capture is divergent, naming the leaf', async () => {
    const w = await world({ level: 3 });
    w.attributes.raw('level', 2);
    w.attributes.raw('tier', 'gold');
    const report = await replayDecision(w.record, w.deps);
    expect(report.replay).to.equal('divergent');
    expect(report.outcome).to.deep.equal({ recorded: 'allow', replayed: 'allow' });
    expect(report.divergence).to.deep.equal([
      { part: 'captured-state', key: 'org:o1#level', recorded: '3', replayed: '2' },
      { part: 'captured-state', key: 'org:o1#tier', recorded: 'absent', replayed: '"gold"' },
    ]);
  });

  it('a leaf the history cannot establish gives no finding and leaves the verdict as it is', async () => {
    const w = await world({ level: 2 });
    await w.attributes.set('level', 2, at(w, -HOUR));
    w.attributes.raw('level', 5);
    const report = await replayDecision(w.record, w.deps);
    expect(report).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash', missing: [], divergence: [] });
    expect(attributeReads(report)).to.have.length(1);
    expect(attributeReads(report)[0]).to.deep.include({ key: 'org:o1#level', origin: 'gap' });

    const uncovered = await world({ level: 2 }, { covered: false });
    uncovered.attributes.raw('level', 5);
    const blind = await replayDecision(uncovered.record, uncovered.deps);
    expect(blind).to.deep.include({ replay: 'faithful', divergence: [] });
    expect(attributeReads(blind)).to.deep.equal([{ kind: 'attribute', key: 'org:o1', origin: 'gap', reason: 'the attribute history starts nowhere (not covered)' }]);
  });

  it('a leaf without a readable value and a change that names no leaf are gaps, never absent', async () => {
    const w = await world({ level: 3 });
    w.attributes.rows.set('org:o1#level', { scope: 'org:o1', path: 'level' });
    await w.log.append([{ kind: 'attribute', op: 'add', key: 'opaque', payload: { leaf: 'tier' }, at: at(w, HOUR / 2) }]);
    const report = await replayDecision(w.record, w.deps);
    expect(report).to.deep.include({ replay: 'faithful', divergence: [] });
    expect(attributeReads(report).map((r) => [r.key, r.origin])).to.deep.equal([
      ['opaque', 'gap'],
      ['org:o1#level', 'gap'],
    ]);
  });

  it('an outcome divergence wins over a captured-state one', async () => {
    const w = await world({ level: 3 }, { principal: 'u2' });
    w.attributes.raw('level', 2);
    const report = await replayDecision(w.record, w.deps);
    expect(report.divergence).to.deep.equal([{ part: 'outcome', recorded: 'allow', replayed: 'deny' }]);
  });

  it('does not run without an attribute contributor or without captured inputs', async () => {
    const w = await world({ level: 3 });
    w.attributes.raw('level', 2);
    const { attributes: _attributes, ...without } = w.deps;
    const unchecked = await replayDecision(w.record, without);
    expect(unchecked).to.deep.include({ replay: 'faithful', evidence: 'inputs-hash' });
    expect(attributeReads(unchecked)).to.deep.equal([]);

    const uncaptured = await world({ level: 3 }, { captureInputs: false });
    uncaptured.attributes.raw('level', 2);
    const report = await replayDecision(uncaptured.record, uncaptured.deps);
    expect(report.replay).to.equal('unreplayable');
    expect(attributeReads(report)).to.deep.equal([]);
  });
});
