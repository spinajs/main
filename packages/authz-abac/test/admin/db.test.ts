import * as chai from 'chai';
import 'mocha';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Orm, OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthzAdminFailure, DefaultConditionCompiler, FALSE, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { AdminCallContext, AuthzCommand, AuthzService, AuthzTx, Policy, Principal } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AbacModel, AbacPolicyHandler, AbacPolicyReader, AbacScopeForgetter, DbPolicyStore, PolicyStore } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-03T12:00:00.000Z');
const alice = userPrincipal('alice');
const P1 = { type: 'project', id: 'p1' };
const P2 = { type: 'project', id: 'p2' };

class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const config = this.Config as Record<string, unknown>;
    config.db = { ...(config.db as object), DefaultConnection: 'abac-admin', Connections: [{ Name: 'abac-admin', Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: true } }] };
  }
}

const put = (p: Omit<Policy, 'source'>): AuthzCommand => ({ kind: 'policy.put', policy: p });

/**
 * The handler, reader and forgetter over DbPolicyStore with a real ORM transaction. AuthzAdmin needs a DB
 * backend for that (task 9), so these tests call them as AuthzAdmin would, inside OrmDriver.transaction.
 */
describe('ABAC admin over DbPolicyStore (sqlite)', function () {
  this.timeout(30_000);
  let container: IContainer;
  let orm: Orm;
  let driver: OrmDriver;
  let store: DbPolicyStore;
  let model: AbacModel;
  let reg: PermissionRegistryImpl;
  const handler = new AbacPolicyHandler();

  before(async () => {
    DI.setESMModuleSupport();
    container = DI.child();
    container.register(TestConfiguration).as(Configuration);
    container.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await container.resolve(Configuration);
    orm = await container.resolve(Orm);
    driver = orm.Connections.get('default')!;
    store = new DbPolicyStore(driver);
    container.register(() => store).as(PolicyStore);
    reg = new PermissionRegistryImpl();
    reg.register([{ name: 'file:read', types: ['file', 'project'] }], 'test');
    reg.freeze();
    model = new AbacModel({ stores: [store] });
    await model.init(fakeModelInitContext({ permissions: reg }));
  });

  after(async () => {
    await orm?.dispose();
  });

  const authz = { models: () => [model], check: async () => ({ allowed: true, residual: TRUE }) } as unknown as AuthzService;
  const context = (actor: Principal = alice): AdminCallContext => Object.freeze({ domain: 'test', now: NOW, authz, actor, container, dryRun: false });
  const write = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => driver.transaction(() => fn({ driver })) as Promise<T>;
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

  it('a rolled back transaction leaves no row', async () => {
    const c = put({ id: 'rolled', effect: 'permit', permissions: ['file:read'] });
    await handler.validate(c, context());
    await write(async (tx) => {
      await handler.apply(c, context(), tx);
      throw new Error('roll back');
    }).catch(() => undefined);
    expect(await ids()).to.not.include('rolled');
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
});
