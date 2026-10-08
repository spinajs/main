import { SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { FakeAdapter, fixtureDsl } from '@spinajs/authz-testing';
import type { World } from '@spinajs/authz-testing';
import { expect } from 'chai';
import 'mocha';

import { OrmResourceAdapter } from '../../../authz-orm/lib/mjs/adapter.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { defineWorldModels, scopeColumnOrder } from './kit-harness.js';

/*
 * The lane SQL harness mirrors a kit world's ancestor chains into `@ScopeColumn`s exactly (authz-orm's adapter gives
 * the same ancestors as the kit's FakeAdapter), or throws where one column per scope type cannot.
 */

const { ref } = fixtureDsl;

const chain = (...keys: string[]): ResourceRef[] => keys.map((k) => ref(k.split(':')[0], k.split(':')[1]));

const MIXED = {
  types: ['file', 'folder', 'project', 'org'],
  // f1 first: first-seen order put folder after org.
  rows: {
    file: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }],
    folder: [{ id: 'd1' }],
    project: [{ id: 'p1' }],
    org: [{ id: 'o1' }],
  },
  parents: [
    [ref('file', 'f1'), ref('project', 'p1')],
    [ref('file', 'f2'), ref('folder', 'd1')],
    [ref('folder', 'd1'), ref('project', 'p1')],
    [ref('project', 'p1'), ref('org', 'o1')],
  ] as const,
};

const world = (adapter: object): World => ({ permissions: [{ name: 'file:read', types: ['file'] }], adapters: [adapter as never] } as unknown as World);

describe('authz-rbac orm-compile: the lane SQL harness mirrors ancestor chains', () => {
  describe('scopeColumnOrder', () => {
    it('orders the scope types nearest first over chains of mixed shape', () => {
      expect(scopeColumnOrder('file', [chain('project:p1', 'org:o1'), chain('folder:d1', 'project:p1', 'org:o1'), []])).to.deep.equal(['folder', 'project', 'org']);
      expect(scopeColumnOrder('file', [chain('folder:d1', 'org:o1'), chain('project:p1', 'org:o1')])).to.deep.equal(['folder', 'project', 'org']);
    });

    it('throws for a chain holding a type twice', () => {
      expect(() => scopeColumnOrder('file', [chain('folder:d2', 'folder:d1', 'project:p1')])).to.throw(/holds 'folder' twice/);
    });

    it("throws for a chain holding the row's own type", () => {
      expect(() => scopeColumnOrder('folder', [chain('folder:d1', 'project:p1')])).to.throw(/holds the row's own type/);
    });

    it('throws for two chains ordering two types both ways', () => {
      expect(() => scopeColumnOrder('file', [chain('folder:d1', 'project:p1'), chain('project:p2', 'folder:d2')])).to.throw(/order 'project' and 'folder' both ways/);
    });

    it('throws for chains ordering three types in a cycle', () => {
      expect(() => scopeColumnOrder('file', [chain('a:1', 'b:1'), chain('b:2', 'c:2'), chain('c:3', 'a:3')])).to.throw(/in a cycle/);
    });
  });

  describe('defineWorldModels refuses what it does not mirror', () => {
    const refuses = (adapter: object, message: RegExp) =>
      defineWorldModels(undefined as never, 'sqlite', world(adapter)).then(
        () => expect.fail('no refusal'),
        (e: Error) => expect(e.message).to.match(message),
      );

    it('an adapter that is not list-scoped', () => refuses({ types: ['file'], compiles: undefined }, /not list-scoped/));
    it('adapter permissions', () => refuses({ types: ['file'], permissions: [{ name: 'file:share', types: ['file'] }] }, /adapter permissions \(file:share\)/));
    it('a folder in a folder', () =>
      refuses(
        {
          types: ['file', 'folder'],
          rows: { file: [{ id: 'f1' }], folder: [{ id: 'd1' }, { id: 'd2' }] },
          parents: [
            [ref('file', 'f1'), ref('folder', 'd2')],
            [ref('folder', 'd2'), ref('folder', 'd1')],
          ],
        },
        /holds the row's own type|holds 'folder' twice/,
      ));
  });

  for (const kind of KINDS) {
    describe(kind, function () {
      this.timeout(120000);
      let db: RootOrm;

      before(async function () {
        db = await RootOrm.open(this, `l4b_kit_harness_${kind}`);
      });

      after(async () => {
        await db?.close();
      });

      it('folder → project → org and file → folder → project → org beside file → project → org: the same ancestors as the kit adapter', async () => {
        await defineWorldModels(db, kind, world(MIXED));
        const kit = new FakeAdapter(MIXED);
        const orm = new OrmResourceAdapter();
        for (const [type, rows] of Object.entries(MIXED.rows)) {
          for (const row of rows) {
            const at = ref(type, row.id);
            const mirrored = await runWithPrincipal(SYSTEM, async () => orm.ancestors(at));
            expect(mirrored, `ancestors of ${type}:${row.id}`).to.deep.equal(await kit.ancestors(at));
          }
        }
        await db.clear();
      });
    });
  }
});
