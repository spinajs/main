import { expect } from 'chai';
import 'mocha';
import * as fc from 'fast-check';

import { TRUE, resourceKey } from '@spinajs/authz';
import type { Vote } from '@spinajs/authz';

import { FakeTupleModel, FakeTupleStore, fakeEvaluationContext, userPrincipal } from '../src/index.js';
import { tupleGraph } from '../src/arbitraries/index.js';
import type { Tuple } from '../src/index.js';

const isUserset = (s: Tuple['subject']): s is { object: { type: string; id?: string }; relation: string } => 'object' in s;

describe('tupleGraph arbitrary', () => {
  it('stays within depthBound: with maxDepth = depthBound no vote is indeterminate and answers match an unbounded walk', async () => {
    await fc.assert(
      fc.asyncProperty(tupleGraph({ folderDepth: 3, groupDepth: 2, width: 3 }), async (g) => {
        expect(g.depthBound).to.eq(6);
        const store = new FakeTupleStore();
        await store.write(g.tuples, [], { type: 'user', id: 'admin' });
        const tight = new FakeTupleModel({ store, schema: g.schema, permissions: g.permissions, maxDepth: g.depthBound });
        const loose = new FakeTupleModel({ store, schema: g.schema, permissions: g.permissions, maxDepth: 40 });
        for (const [type, permission] of [
          ['doc', 'doc:read'],
          ['folder', 'folder:read'],
        ] as const) {
          for (const row of g.rows[type]) {
            for (const u of g.users) {
              const req = { principal: userPrincipal(u.id), permission, resource: { type, id: row.id } };
              const a = (await tight.evaluate(req, fakeEvaluationContext())) as Vote;
              const b = (await loose.evaluate(req, fakeEvaluationContext())) as Vote;
              expect(a.error, `${u.id} ${permission} ${row.id}`).to.eq(undefined);
              expect(a.permitWhen).to.eq(b.permitWhen);
            }
          }
        }
        await tight.dispose();
        await loose.dispose();
      }),
      { numRuns: 30 },
    );
  });

  it('bounds fan-out, points group usersets one level down and folder parents one level up', () => {
    fc.assert(
      fc.property(tupleGraph({ width: 2 }), (g) => {
        const perRelation = new Map<string, number>();
        for (const t of g.tuples) {
          const key = `${resourceKey(t.object)}#${t.relation}`;
          perRelation.set(key, (perRelation.get(key) ?? 0) + 1);
          if (t.object.type === 'group' && isUserset(t.subject)) {
            const level = (id: string) => Number(id.slice(1).split('_')[0]);
            expect(level(t.subject.object.id!)).to.eq(level(t.object.id!) + 1);
          }
          if (t.object.type === 'folder' && t.relation === 'parent') {
            const level = (id: string) => Number(id.slice(1).split('_')[0]);
            expect(level((t.subject as { id: string }).id)).to.eq(level(t.object.id!) - 1);
          }
        }
        for (const [key, n] of perRelation) expect(n, key).to.be.at.most(2);
        expect(g.rows.doc.length).to.be.at.least(1);
        expect(g.rows.folder.length).to.be.at.least(1);
      }),
      { numRuns: 100 },
    );
  });

  it('refuses options whose depth bound exceeds maxDepth', () => {
    expect(() => tupleGraph({ folderDepth: 5, groupDepth: 3, maxDepth: 8 })).to.throw(/exceeds maxDepth 8/);
    expect(() => tupleGraph({ folderDepth: 5, groupDepth: 2, maxDepth: 8 })).to.not.throw();
  });

  it('feeds FakeTupleModel: some user reaches some doc', async () => {
    const [g] = fc.sample(tupleGraph({ width: 3 }), { numRuns: 1, seed: 5 });
    const store = new FakeTupleStore();
    await store.write(g.tuples, [], { type: 'user', id: 'admin' });
    const m = new FakeTupleModel({ store, schema: g.schema, permissions: g.permissions });
    let granted = 0;
    for (const row of g.rows.doc) for (const u of g.users) if (((await m.evaluate({ principal: userPrincipal(u.id), permission: 'doc:read', resource: { type: 'doc', id: row.id } }, fakeEvaluationContext())) as Vote).permitWhen === TRUE) granted++;
    expect(granted).to.be.above(0);
  });
});
