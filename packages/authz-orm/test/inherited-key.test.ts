import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, ScopeForgetter, TRUE, authzStorage, changeLog, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AdminContext, AuthzEvent, AuthzTx, Decision, Principal, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { ModelBase, Primary } from '@spinajs/orm';

import { AuthzOrmContributor } from '../src/contributor.js';
import { AccessResource, Owner, entryOf, registerAccessResource } from '../src/index.js';
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

type Q = PromiseLike<ModelBase[]> & { accessible(p: string): Q; where(...a: unknown[]): Q };
type M = typeof ModelBase & { query(): Q; where(...a: unknown[]): Q; insert(v: object): Promise<unknown> };

const TWO_TENANTS = [
  { id: 'd1', tenant: 't1', owner_id: 'alice' },
  { id: 'd1', tenant: 't2', owner_id: 'bob' },
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

const refusal = (model: string, resource: string, keys: string, added: string) =>
  new RegExp(`^authz-orm: model ${model}_\\d+_\\d+ extends @AccessResource model ${resource} and adds ${added} to its primary key \\(${keys}\\); a resource is identified by one key column, so rows that differ only in ${added} would be one resource: do not add a key column, or make ${model}_\\d+_\\d+ a model of its own that does not extend ${resource.split(' ')[0]}, with an @AccessResource type of its own and a single-column key$`);

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
        await tenantDoc();
        const error = await boot();
        expect(error).to.be.instanceOf(AuthzConfigError);
        expect((error as Error).message).to.match(refusal('TenantDoc', `Doc_\\d+_\\d+ \\(resource 'doc'\\)`, 'id, tenant', 'tenant'));
      });

      it('boots a subclass that adds no key column, which reads and lists as its parent does', async () => {
        const SubDoc = (await db.define({ name: 'SubDoc', base: Doc, columns: { owner_id: 'TEXT' }, rows: [{ id: 'd1', owner_id: 'alice' }, { id: 'd2', owner_id: 'bob' }] }, dialect)) as M;
        expect(await boot()).to.have.property('listTypes').that.includes('doc');
        sinon.stub(await (await testHost.domains()).service('root'), 'accessPlan').resolves(withinD1);
        const rows = await runWithPrincipal(alice, async () => await SubDoc.query().accessible('doc:read'));
        expect(rows.map((r) => r.PrimaryKeyValue)).to.deep.equal(['d1']);
        expect(entryOf(SubDoc)).to.deep.include({ registered: Doc, idColumns: ['id'] });
      });

      it('refuses a subclass two levels down whose middle class added the key column', async () => {
        class Middle extends Doc {}
        Primary()(Middle.prototype, 'tenant');
        const Leaf = await db.define({ name: 'Leaf', base: Middle, columns: { tenant: 'TEXT', owner_id: 'TEXT' }, primary: ['id', 'tenant'] }, dialect);
        const error = await boot();
        expect((error as Error).message).to.match(refusal('Leaf', `Doc_\\d+_\\d+ \\(resource 'doc'\\)`, 'id, tenant', 'tenant'));
        expect(() => entryOf(Leaf)).to.throw(AuthzConfigError, /adds tenant to its primary key/);
      });

      it("refuses a subclass of a resource another package registered with registerAccessResource(), as a fragment does", async () => {
        const Shared = await db.define({ name: 'Shared', columns: { owner_id: 'TEXT' } }, dialect);
        registerAccessResource(Shared, 'shared');
        await tenantDoc(Shared);
        const error = await boot();
        expect((error as Error).message).to.match(refusal('TenantDoc', `Shared_\\d+_\\d+ \\(resource 'shared'\\)`, 'id, tenant', 'tenant'));
      });

      it('refuses a subclass loaded after the boot at its first use, with the same error', async () => {
        expect(await boot()).to.have.property('listTypes').that.includes('doc');
        const TenantDoc = await tenantDoc();
        expect(() => entryOf(TenantDoc)).to.throw(AuthzConfigError, refusal('TenantDoc', `Doc_\\d+_\\d+ \\(resource 'doc'\\)`, 'id, tenant', 'tenant'));
        // The whole key is a single-object load the guard lets through: only the refusal stops it.
        const read = await settle(() => authzStorage().run({ Principal: alice, AuthzDecision: decided }, async () => await TenantDoc.where('id', 'd1').where('tenant', 't2')));
        expect(read).to.be.instanceOf(AuthzConfigError);
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
