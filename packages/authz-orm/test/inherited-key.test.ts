import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, ScopeForgetter, TRUE, authzStorage, changeLog, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AdminContext, AuthzEvent, AuthzTx, Decision, Principal, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { ModelBase, Primary } from '@spinajs/orm';

import { AuthzOrmContributor } from '../src/contributor.js';
import { AccessResource, Owner, entryOf, registerAccessResource } from '../src/index.js';
import { setMarks } from '../src/marker.js';
import { rlsResources } from '../src/rls/index.js';
import { createAncestorTable, dropAncestorTable } from './support/ancestors.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';

const expect = chai.expect;

class NoopForgetter extends ScopeForgetter {
  async forget(_scope: ResourceRef, _ctx: AdminContext, _tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 0, tags: [], events: [] };
  }
}

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
// Alice may read doc d1, which in the subclass's table is two rows: tenant t1's (hers) and tenant t2's (bob's).
const withinD1: AccessPlan = { kind: 'filter', permit: 'all', deny: [], within: [{ type: 'doc', id: 'd1' }] };
const decided = { allowed: true, permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, residual: TRUE } as unknown as Decision;

type Q = PromiseLike<ModelBase[]> & {
  accessible(p: string): Q;
  within(ref: ResourceRef): Q;
  withAccess(p: string[]): Q;
  withFields(p: string): Q;
  unscoped(reason: string): Q;
  where(...a: unknown[]): Q;
};
type M = typeof ModelBase & { query(): Q; where(...a: unknown[]): Q; insert(v: object): Promise<unknown> };
// ModelBase's own query() comes first in M's overloads and has no withFields().
const queryOf = (model: { query(): Q }): Q => model.query();

const TWO_TENANTS = [
  { id: 'd1', tenant: 't1', owner_id: 'alice' },
  { id: 'd1', tenant: 't2', owner_id: 'bob' },
];

// Alice may read order o1, whose lines are l1 (hers) and l2 (bob's): keyed by order_id alone, both are 'late:o1'.
const withinO1: AccessPlan = { kind: 'filter', permit: 'all', deny: [], within: [{ type: 'late', id: 'o1' }] };
const ORDER_O1 = [
  { order_id: 'o1', id: 'l1', owner_id: 'alice' },
  { order_id: 'o1', id: 'l2', owner_id: 'bob' },
];

const settle = async (fn: () => PromiseLike<unknown>): Promise<unknown> => {
  try {
    return await fn();
  } catch (e) {
    return e;
  }
};
const boot = () => settle(() => new AuthzOrmContributor().contribute('root'));
const docKeys = (rows: unknown): string[] => (rows as { id: string; tenant: string }[]).map((r) => `${r.id}/${r.tenant}`).sort();
const ids = (rows: unknown): string[] => (rows as { id: string }[]).map((r) => r.id).sort();

const refusal = (model: typeof ModelBase, resource: typeof ModelBase, type: string) =>
  `authz-orm: model ${model.name} extends @AccessResource model ${resource.name} (resource '${type}') and adds tenant to its primary key (id, tenant); a resource is identified by one key column, so rows that differ only in tenant would be one resource: do not add a key column, or make ${model.name} a model of its own that does not extend ${resource.name}, with an @AccessResource type of its own and a single-column key`;

const compositeRefusal = (model: typeof ModelBase, type: string) =>
  `authz-orm: @AccessResource model ${model.name} (resource '${type}') has a composite primary key (order_id, id); the ORM write capture, which keeps authz_resource_ancestor and the column changelog, needs a single-column primary key`;

describe('authz-orm: a subclass of a resource that adds a key column', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Doc: typeof ModelBase;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        undo.push(testHost.registerInRoot(ScopeForgetter, testHost.instance(new NoopForgetter())));
        await createAncestorTable(db, dialect);
        Doc = await db.define(
          {
            name: 'Doc',
            columns: { owner_id: 'TEXT' },
            decorate: (c, p) => {
              AccessResource('doc', { rls: true })(c);
              Owner()(p, 'owner_id');
            },
          },
          dialect,
        );
      });

      afterEach(async () => {
        sinon.restore();
        for (const fn of undo.splice(0).reverse()) fn();
        await testHost.resetRoot();
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const tenantDoc = (base: typeof ModelBase = Doc) => db.define({ name: 'TenantDoc', base, columns: { tenant: 'TEXT', owner_id: 'TEXT' }, primary: ['id', 'tenant'], rows: TWO_TENANTS }, dialect) as Promise<M>;

      it('refuses at domain boot a subclass that adds @Primary() to a single-key resource, naming it, its key and its resource', async () => {
        const TenantDoc = await tenantDoc();
        expect(await boot()).to.be.instanceOf(AuthzConfigError).with.property('message', refusal(TenantDoc, Doc, 'doc'));
      });

      it('boots a subclass that adds no key column, which reads and lists as its parent does', async () => {
        const SubDoc = (await db.define({ name: 'SubDoc', base: Doc, columns: { owner_id: 'TEXT' }, rows: [{ id: 'd1', owner_id: 'alice' }, { id: 'd2', owner_id: 'bob' }] }, dialect)) as M;
        expect(await boot()).to.have.property('listTypes').that.includes('doc');
        sinon.stub(await (await testHost.domains()).service('root'), 'accessPlan').resolves(withinD1);
        const rows = await runWithPrincipal(alice, async () => await SubDoc.query().accessible('doc:read'));
        expect(ids(rows)).to.deep.equal(['d1']);
        expect(entryOf(SubDoc)).to.deep.include({ registered: Doc, idColumns: ['id'] });
      });

      it('refuses a subclass two levels down whose middle class added the key column', async () => {
        class Middle extends Doc {
          @Primary() public tenant: string;
        }
        const Leaf = await db.define({ name: 'Leaf', base: Middle, columns: { tenant: 'TEXT', owner_id: 'TEXT' }, primary: ['id', 'tenant'] }, dialect);
        expect(await boot()).to.be.instanceOf(AuthzConfigError).with.property('message', refusal(Leaf, Doc, 'doc'));
        expect(() => entryOf(Leaf)).to.throw(AuthzConfigError, refusal(Leaf, Doc, 'doc'));
      });

      it("refuses a subclass of a resource another package registered with registerAccessResource(), as a fragment does", async () => {
        const Shared = await db.define({ name: 'Shared', columns: { owner_id: 'TEXT' } }, dialect);
        registerAccessResource(Shared, 'shared');
        const TenantDoc = await tenantDoc(Shared);
        expect(await boot()).to.be.instanceOf(AuthzConfigError).with.property('message', refusal(TenantDoc, Shared, 'shared'));
      });

      it('refuses a subclass loaded after the boot at its first use, with the same error', async () => {
        expect(await boot()).to.have.property('listTypes').that.includes('doc');
        const TenantDoc = await tenantDoc();
        expect(() => entryOf(TenantDoc)).to.throw(AuthzConfigError, refusal(TenantDoc, Doc, 'doc'));
        // The whole key is a single-object load the guard lets through: only the refusal stops it.
        const read = await settle(() => authzStorage().run({ Principal: alice, AuthzDecision: decided }, async () => await TenantDoc.where('id', 'd1').where('tenant', 't2')));
        expect(read).to.be.instanceOf(AuthzConfigError);
      });

      describe('a composite-key resource registered after the boot, which the boot check never saw', () => {
        let Late: M;

        beforeEach(async () => {
          sinon.stub(await (await testHost.domains()).service('root'), 'accessPlan').resolves(withinO1);
          Late = (await db.define({ name: 'Late', columns: { order_id: 'TEXT', owner_id: 'TEXT' }, primary: ['order_id', 'id'], rows: ORDER_O1 }, dialect)) as M;
          registerAccessResource(Late, 'late');
        });

        it(".accessible() and the other list methods refuse it: keyed by order_id alone, a grant on order o1 would list bob's line l2", async () => {
          const list = await settle(() => runWithPrincipal(alice, async () => await Late.query().accessible('late:read')));
          expect(list).to.be.instanceOf(AuthzConfigError).with.property('message', compositeRefusal(Late, 'late'));
          const marks: ((q: Q) => Q)[] = [(q) => q.accessible('late:read'), (q) => q.within({ type: 'late', id: 'o1' }), (q) => q.withAccess(['late:read']), (q) => q.withFields('late:read'), (q) => q.unscoped('report')];
          for (const mark of marks) expect(() => mark(queryOf(Late))).to.throw(AuthzConfigError, compositeRefusal(Late, 'late'));
        });

        it('the list middleware refuses it too, for a mark that reached the query past .accessible()', async () => {
          const query = Late.query();
          setMarks(query, { accessible: 'late:read' });
          expect(await settle(() => runWithPrincipal(alice, async () => await query))).to.be.instanceOf(AuthzConfigError).with.property('message', compositeRefusal(Late, 'late'));
        });
      });

      describe('the paths that key the subclass by its first key column cannot be entered', () => {
        let TenantDoc: M;

        beforeEach(async () => {
          sinon.stub(await (await testHost.domains()).service('root'), 'accessPlan').resolves(withinD1);
          TenantDoc = await tenantDoc();
        });

        it(".accessible(): a grant on doc d1 would list tenant t2's row too", async () => {
          expect(await settle(() => runWithPrincipal(alice, async () => await TenantDoc.query().accessible('doc:read')))).to.be.instanceOf(AuthzConfigError);
        });

        it('the write capture and the changelog: a write of the subclass is refused by authz before the ORM capture, and nothing is logged', async () => {
          const seq = (await changeLog().since(0)).at(-1)?.seq ?? 0;
          expect(await settle(() => TenantDoc.insert({ id: 'd2', tenant: 't1', owner_id: 'alice' }))).to.be.instanceOf(AuthzConfigError);
          expect(await changeLog().since(seq)).to.deep.equal([]);
          expect(docKeys(await db.rows(TenantDoc))).to.deep.equal(['d1/t1', 'd1/t2']);
        });

        it("row level security: authz:rls gives the subclass's table no policy, and a policy for it would key its rows by id alone", async () => {
          // authz:rls boots the domain before it reads the resources.
          expect(await boot()).to.be.instanceOf(AuthzConfigError);
          expect(() => rlsResources([TenantDoc])).to.throw(AuthzConfigError, /adds tenant to its primary key/);
        });
      });
    });
  }
});
