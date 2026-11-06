import 'mocha';
import { expect } from 'chai';

import type { PolicyIR } from '@spinajs/authz-ir';
import { Encoder, Unsupported, and, not, or, outcome, principalTypes, universes } from '../../src/index.js';
import type { Formula, Universe, WitnessTuple } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';
import { foldersIR, invoicesIR } from '../fixtures/invoices.js';

/** Truth of a formula under the variables that hold, definitions expanded. */
function truth(f: Formula, defs: ReadonlyMap<string, Formula>, holds: ReadonlySet<string>): boolean {
  if (typeof f === 'boolean') return f;
  if ('var' in f) return defs.has(f.var) ? truth(defs.get(f.var)!, defs, holds) : holds.has(f.var);
  if ('not' in f) return !truth(f.not, defs, holds);
  if ('and' in f) return f.and.every((x) => truth(x, defs, holds));
  if ('or' in f) return f.or.some((x) => truth(x, defs, holds));
  throw new TypeError('these fixtures have no caveats');
}

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random tuple sets over the encoder's variables, one target per column, compared with the reference evaluator. */
async function agree(ir: PolicyIR, u: Universe, permissions: string[], rounds: number, seed: number): Promise<void> {
  const encoder = new Encoder(ir, u, { maxDepth: 8 });
  const goals = permissions.map((p) => encoder.check(p));
  const next = random(seed);
  for (let round = 0; round < rounds; round++) {
    const holds = new Set<string>();
    const taken = new Set<string>();
    for (const [name, t] of encoder.tuples) {
      const column = `${t.object.type}:${t.object.id}#${t.relation}`;
      const isColumn = [...encoder.columns.values()].some((vars) => vars.includes(name));
      if (next() < 0.35 && !(isColumn && taken.has(column))) {
        holds.add(name);
        taken.add(column);
      }
    }
    const tuples: WitnessTuple[] = [...holds].map((name) => encoder.tuples.get(name)!);
    const got = await outcome(ir, { principal: u.principal, resource: u.resource, tuples }, permissions);
    permissions.forEach((p, i) => expect(truth(goals[i], encoder.defs, holds), `${p} round ${round} seed ${seed}: ${[...holds].join(' ')}`).to.equal(got[p] === 'allow'));
  }
}

describe('bounded encoding', () => {
  it('builds one universe per principal type, with a second resource when the types coincide', () => {
    expect(principalTypes(invoicesIR())).to.deep.equal(['org', 'project', 'user']);
    const us = universes(foldersIR(), 3, 'folder');
    expect(us.map((u) => `${u.principal.id}->${u.resource.id}`)).to.deep.equal(['f1->f1', 'f1->f2', 'u1->f1']);
    expect(us[0].objects.folder.map((o) => o.id)).to.deep.equal(['f1', 'f2', 'f3']);
  });

  it('simplifies constants', () => {
    expect(and(true, { var: 'x' })).to.deep.equal({ var: 'x' });
    expect(or(false, false)).to.equal(false);
    expect(not(not({ var: 'x' }))).to.deep.equal({ var: 'x' });
  });

  it('agrees with the reference evaluator on random data, through intersections, exclusions and recursion', async () => {
    const invoices = invoicesIR();
    delete invoices.types.invoice.relations.frozen;
    invoices.types.invoice.relations.banned = { allowed: ['user'], source: { kind: 'tuples', store: 't' } };
    invoices.types.invoice.permissions.update = { exclusion: { base: { computed: 'approve' }, subtract: { computed: 'banned' } } };
    const [user] = universes(invoices, 2, 'invoice').filter((u) => u.principal.type === 'user');
    await agree(invoices, user, ['invoice:read', 'invoice:approve', 'invoice:update'], 60, 7);
    for (const u of universes(foldersIR(), 2, 'folder')) await agree(foldersIR(), u, ['folder:read', 'folder:update', 'folder:browse'], 60, 11);
  });

  it('encodes first-applicable priority chains', async () => {
    const ir = foldersIR();
    ir.types.folder.permissions.view = { priority: [{ when: { computed: 'edit' }, then: 'deny' }, { when: { computed: 'viewer' }, then: 'permit' }] };
    const [user] = universes(ir, 2, 'folder').filter((u) => u.principal.type === 'user');
    await agree(ir, user, ['folder:read'], 40, 3);
  });

  it('refuses opaque rewrites and encodes caveated tuples with their caveat', () => {
    const ir = docsIR();
    ir.types.doc.permissions.edit = { union: [{ opaque: 'model:legacy' }, { computed: 'editor' }] };
    const [user] = universes(ir, 2, 'doc').filter((u) => u.principal.type === 'user');
    expect(() => new Encoder(ir, user, { maxDepth: 8 }).check('doc:update')).to.throw(Unsupported);
    const encoder = new Encoder(docsIR(), user, { maxDepth: 8 });
    encoder.check('doc:update');
    expect([...encoder.tuples.keys()]).to.include('t:doc:d1#editor@user:u1[office_hours]');
    expect([...encoder.caveats.params]).to.deep.equal([['c:env.hour', 'int']]);
  });

  it('fixes the tuples a query rules out to false', () => {
    const [user] = universes(foldersIR(), 2, 'folder').filter((u) => u.principal.type === 'user');
    const encoder = new Encoder(foldersIR(), user, { maxDepth: 8, admit: (t) => t.relation !== 'viewer' });
    encoder.check('folder:browse');
    expect([...encoder.tuples.values()].some((t) => t.relation === 'viewer')).to.equal(false);
  });
});
