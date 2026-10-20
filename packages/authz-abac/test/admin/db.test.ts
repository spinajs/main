import * as chai from 'chai';
import 'mocha';
import { AuthzAdminFailure, AuthzConfigError, DefaultConditionCompiler, FALSE, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { AdminCallContext, AuthzCommand, AuthzService, AuthzTx, Policy, Principal } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_POLICY_TABLE, AbacModel, AbacPolicyHandler, AbacPolicyReader, AbacScopeForgetter, DbPolicyStore, PolicyStore } from '../../src/index.js';
import { DB_KINDS, bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const NOW = new Date('2026-10-03T12:00:00.000Z');
const alice = userPrincipal('alice');
const P1 = { type: 'project', id: 'p1' };
const P2 = { type: 'project', id: 'p2' };

const put = (p: Omit<Policy, 'source'>): AuthzCommand => ({ kind: 'policy.put', policy: p });

for (const kind of DB_KINDS) {
  /** The handler, reader and forgetter over DbPolicyStore, called as AuthzAdmin calls them, inside OrmDriver.transaction. */
  describe(`ABAC admin over DbPolicyStore (${kind})`, function () {
    this.timeout(60_000);

    let db: TestDb;
    let store: DbPolicyStore;
    let model: AbacModel;
    let reg: PermissionRegistryImpl;
    const handler = new AbacPolicyHandler();

    before(async function () {
      db = await bootDb(this, kind, 'abac_admin');
      store = new DbPolicyStore();
      db.container.register(() => store).as(PolicyStore);
      reg = new PermissionRegistryImpl();
      reg.register([{ name: 'file:read', types: ['file', 'project'] }], 'test');
      reg.freeze();
      model = new AbacModel({ stores: [store] });
      await model.init(fakeModelInitContext({ permissions: reg }));
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await db.driver.del().from(AUTHZ_POLICY_TABLE);
    });

    // bob manages everything but project:p2.
    const authz = { models: () => [model], check: async (req: { principal: Principal; resource: { id?: string } }) => (req.principal.id === 'bob' && req.resource.id === 'p2' ? { allowed: false } : { allowed: true, residual: TRUE }) } as unknown as AuthzService;
    const context = (actor: Principal = alice): AdminCallContext => Object.freeze({ domain: 'test', now: NOW, authz, actor, container: db.container, dryRun: false });
    const write = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => db.driver.transaction(() => fn({ driver: db.driver })) as Promise<T>;
    const ids = async (): Promise<string[]> => (await store.load()).map((p) => p.id);

    /** validate, then apply in a transaction, as AuthzAdmin runs a command. */
    async function run(c: AuthzCommand, actor: Principal = alice) {
      const ctx = context(actor);
      await handler.validate(c, ctx);
      return write((tx) => handler.apply(c, ctx, tx));
    }

    async function refusal(c: AuthzCommand, actor: Principal = alice): Promise<{ code: string; field?: string }> {
      try {
        await handler.validate(c, context(actor));
      } catch (e) {
        if (e instanceof AuthzAdminFailure) return { code: e.code, ...(e.field !== undefined ? { field: e.field } : {}) };
        throw e;
      }
      throw new Error('expected a refusal');
    }

    it('puts and deletes in the transaction, with the store tags and PolicyChanged', async () => {
      const out = await run(put({ id: 'open', effect: 'permit', permissions: ['file:read'], scope: P1 }));
      expect(out).to.deep.include({ id: 'open', affected: 1, tags: ['policy', 'policy:open'] });
      expect(out.events.map((e) => [e.type, e.data])).to.deep.equal([['PolicyChanged', { id: 'open', scope: P1, op: 'put' }]]);
      expect(await ids()).to.deep.equal(['open']);

      const ctx = fakeEvaluationContext({ now: NOW, permissions: reg, conditions: new DefaultConditionCompiler() });
      const req = { principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW } };
      model.invalidate(out.tags);
      expect((await model.evaluate(req, ctx)).permitWhen).to.not.equal(FALSE);

      const gone = await run({ kind: 'policy.delete', id: 'open' });
      expect(gone).to.deep.include({ id: 'open', affected: 1, tags: ['policy', 'policy:open'] });
      expect(await ids()).to.deep.equal([]);
      model.invalidate(gone.tags);
      expect((await model.evaluate(req, ctx)).permitWhen).to.equal(FALSE);
    });

    it('a delete of a row gone meanwhile affects nothing', async () => {
      await run(put({ id: 'x', effect: 'permit', permissions: ['file:read'] }));
      const c: AuthzCommand = { kind: 'policy.delete', id: 'x' };
      await handler.validate(c, context());
      await write((tx) => store.delete('x', tx));
      expect(await write((tx) => handler.apply(c, context(), tx))).to.deep.equal({ id: 'x', affected: 0, tags: [], events: [] });
    });

    it('a row moved to another scope since validate is checked again in the transaction', async () => {
      const bob = userPrincipal('bob');
      await run(put({ id: 'moved', effect: 'permit', permissions: ['file:read'], scope: P1 }));
      const c: AuthzCommand = { kind: 'policy.delete', id: 'moved' };
      await handler.validate(c, context(bob));
      expect((await handler.permission(c, context(bob))).resource).to.deep.equal(P1);
      await write((tx) => store.put({ id: 'moved', effect: 'permit', permissions: ['file:read'], scope: P2 }, alice, tx, NOW));
      const e = await write((tx) => handler.apply(c, context(bob), tx)).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(e).to.be.instanceOf(AuthzAdminFailure);
      expect((e as AuthzAdminFailure).code).to.equal('forbidden');
      expect((await store.load()).find((p) => p.id === 'moved')?.scope).to.deep.equal(P2);
    });

    it('a rolled back transaction leaves no row', async () => {
      const c = put({ id: 'rolled', effect: 'permit', permissions: ['file:read'] });
      await handler.validate(c, context());
      await write(async (tx) => {
        await handler.apply(c, context(), tx);
        throw new Error('roll back');
      }).catch(() => undefined);
      expect(await ids()).to.not.include('rolled');
    });

    it('a batch reads its own earlier writes', async () => {
      const c = put({ id: 'same-batch', effect: 'permit', permissions: ['file:read'] });
      await handler.validate(c, context());
      const out = await write(async (tx) => {
        await handler.apply(c, context(), tx);
        return handler.apply({ kind: 'policy.delete', id: 'same-batch' }, context(), tx);
      });
      expect(out).to.deep.include({ id: 'same-batch', affected: 1, tags: ['policy', 'policy:same-batch'] });
      expect(await ids()).to.deep.equal([]);
    });

    it('refuses a transaction on another connection than authz_policy', async () => {
      const c = put({ id: 'elsewhere', effect: 'permit', permissions: ['file:read'] });
      const e = await db.second.transaction((driver: OrmDriver) => handler.apply(c, context(), { driver })).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect((e as Error).message).to.equal('policiesInTx: the AuthzTx runs on connection "abac-abac_admin-second", but authz_policy is on connection "abac-abac_admin" (db.Aliases.authz)');
    });

    it('refuses what does not fit the columns before the transaction', async () => {
      const long = 'x'.repeat(65);
      expect(await refusal(put({ id: 'p', effect: 'deny', permissions: ['file:read'], reason: long }))).to.deep.equal({ code: 'invalid_command', field: 'policy.reason' });
      expect(await refusal(put({ id: 'p', effect: 'deny', permissions: ['file:read'], scope: { type: 'project', id: long } }))).to.deep.equal({ code: 'invalid_command', field: 'policy.scope' });
      expect(await refusal(put({ id: 'p', effect: 'deny', permissions: ['file:read'], scope: { type: long, id: 'a' } }))).to.deep.equal({ code: 'invalid_command', field: 'policy.scope' });
      expect((await refusal(put({ id: 'p', effect: 'deny', permissions: ['file:read'] }), userPrincipal('u'.repeat(100)))).code).to.equal('invalid_command');
    });

    it('the reader pages over the table and the forgetter deletes the rows at the node', async () => {
      for (const [id, scope] of [
        ['f1', P1],
        ['f2', P1],
        ['f3', P2],
      ] as const)
        await run(put({ id, effect: 'permit', permissions: ['file:read'], scope }));
      const reader = new AbacPolicyReader();
      expect(await reader.list({ kind: 'policies', scope: P1, page: { limit: 1, offset: 0 } }, context())).to.deep.equal({ items: [{ id: 'f1', effect: 'permit', permissions: ['file:read'], scope: P1, source: 'db' }], total: 2 });
      const out = await write((tx) => new AbacScopeForgetter().forget(P1, context(), tx));
      expect(out.affected).to.equal(2);
      expect([...out.tags].sort()).to.deep.equal(['policy', 'policy:f1', 'policy:f2']);
      expect(await ids()).to.deep.equal(['f3']);
    });

    it('a row whose JSON does not parse fails the forgetter with the AuthzConfigError naming the table', async () => {
      await rawQuery(db.driver, `INSERT INTO ${AUTHZ_POLICY_TABLE} (id, effect, permissions, scope_type, scope_id, created_at) VALUES ('broken', 'permit', '[oops', 'project', 'p1', '2026-10-01 00:00:00')`, [], QueryContext.Insert);
      const e = await write((tx) => new AbacScopeForgetter().forget(P1, context(), tx)).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect((e as Error).message).to.match(/^authz_policy: a row holds a JSON column that does not parse \(/);
    });
  });
}
