import * as chai from 'chai';
import 'mocha';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthzConfigError, DefaultConditionCompiler, FALSE, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Policy } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AUTHZ_POLICY_TABLE, AbacModel, AuthzAbac_2026_10_01_00_00_00, DbPolicyStore } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice = userPrincipal('alice');

class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const config = this.Config as Record<string, unknown>;
    config.db = { ...(config.db as object), DefaultConnection: 'abac', Connections: [{ Name: 'abac', Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: true } }] };
  }
}

const raw = (driver: OrmDriver, sql: string): Promise<any[]> => (driver as unknown as { executeOnDb(s: string, b: unknown[], c: QueryContext): Promise<any[]> }).executeOnDb(sql, [], QueryContext.Select);

const policies: Policy[] = [
  { id: 'full', effect: 'deny', permissions: ['file:read', 'file:write'], resourceTypes: ['file'], principalTypes: ['user'], actorTypes: ['agent'], scope: { type: 'org', id: 'o1' }, when: { attr: 'resource.status', eq: 'locked' }, fields: { hide: ['email'] }, reason: 'locked', priority: 100, expiresAt: new Date('2026-12-01T00:00:00.000Z'), source: 'admin' },
  { id: 'plain', effect: 'permit', permissions: ['file:read'], source: 'admin' },
  { id: 'typed-scope', effect: 'permit', permissions: ['file:read'], scope: { type: 'org' }, source: 'admin' },
];

describe('authz-abac: AuthzAbac migration and DbPolicyStore (sqlite)', function () {
  this.timeout(30_000);
  let container: IContainer;
  let orm: Orm;
  let driver: OrmDriver;

  before(async () => {
    DI.setESMModuleSupport();
    container = DI.child();
    container.register(TestConfiguration).as(Configuration);
    container.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await container.resolve(Configuration);
    orm = await container.resolve(Orm);
    driver = orm.Connections.get('default')!;
  });

  after(async () => {
    await orm?.dispose();
  });

  const write = <T>(fn: (tx: { driver: OrmDriver }) => Promise<T>): Promise<T> => driver.transaction(() => fn({ driver })) as Promise<T>;

  it('creates authz_policy with the design columns, actor_types and priority, and its scope index', async () => {
    const columns = (await raw(driver, `PRAGMA table_info("${AUTHZ_POLICY_TABLE}")`)).map((c) => [c.name, c.notnull === 1, c.pk === 1]);
    expect(columns).to.deep.equal([
      ['id', true, true],
      ['effect', true, false],
      ['permissions', true, false],
      ['resource_types', false, false],
      ['principal_types', false, false],
      ['actor_types', false, false],
      ['scope_type', true, false],
      ['scope_id', true, false],
      ['condition', false, false],
      ['fields', false, false],
      ['reason', false, false],
      ['priority', false, false],
      ['expires_at', false, false],
      ['created_by', false, false],
      ['created_at', true, false],
    ]);
    const indexes = (await raw(driver, `PRAGMA index_list("${AUTHZ_POLICY_TABLE}")`)).map((i) => i.name);
    expect(indexes).to.include('authz_policy_scope');
    expect(AuthzAbac_2026_10_01_00_00_00.name).to.equal('AuthzAbac_2026_10_01_00_00_00');
  });

  it('round-trips every policy member; writes give the policy tags', async () => {
    const store = new DbPolicyStore(driver);
    const v0 = await store.version();
    for (const p of policies) {
      const { source: _source, ...rest } = p;
      expect(await write((tx) => store.put(rest, alice, tx, NOW))).to.deep.equal({ affected: 1, tags: ['policy', `policy:${p.id}`] });
    }
    const loaded = await store.load();
    expect(loaded.map((p) => p.id)).to.deep.equal(['full', 'plain', 'typed-scope']);
    expect(loaded[0]).to.deep.equal({ ...policies[0], source: 'db' });
    expect(loaded[1]).to.deep.equal({ ...policies[1], source: 'db' });
    expect(loaded[2]).to.deep.equal({ ...policies[2], source: 'db' });
    const created = await raw(driver, `SELECT created_by FROM ${AUTHZ_POLICY_TABLE} WHERE id = 'full'`);
    expect(created[0].created_by).to.equal('user:alice');
    expect(await store.version()).to.not.equal(v0);
  });

  it('replaces on put, deletes by id, and changes its version each time', async () => {
    const store = new DbPolicyStore(() => driver);
    const v1 = await store.version();
    await write((tx) => store.put({ id: 'plain', effect: 'deny', permissions: ['file:read'] }, undefined, tx, NOW));
    expect((await store.load()).find((p) => p.id === 'plain')?.effect).to.equal('deny');
    const v2 = await store.version();
    expect(v2).to.not.equal(v1);
    expect(await write((tx) => store.delete('plain', tx))).to.deep.equal({ affected: 1, tags: ['policy', 'policy:plain'] });
    expect(await write((tx) => store.delete('plain', tx))).to.deep.equal({ affected: 0, tags: [] });
    expect(await store.version()).to.not.equal(v2);
  });

  it('writes only inside an AuthzAdmin transaction', async () => {
    const store = new DbPolicyStore(driver);
    let error: unknown;
    await store.put({ id: 'x', effect: 'permit', permissions: ['file:read'] }, undefined, { driver }).catch((e) => (error = e));
    expect(error).to.be.instanceOf(AuthzConfigError);
    expect((error as Error).message).to.match(/only inside an AuthzAdmin transaction/);
    error = undefined;
    await store.delete('x', { driver: {} }).catch((e) => (error = e));
    expect((error as Error).message).to.match(/must be the OrmDriver/);
  });

  it('feeds AbacModel, which reloads on the policy tags of a write', async () => {
    const reg = new PermissionRegistryImpl();
    reg.register(
      [
        { name: 'file:read', types: ['file'] },
        { name: 'file:write', types: ['file'] },
      ],
      'test',
    );
    reg.freeze();
    const store = new DbPolicyStore(driver);
    await write((tx) => store.delete('typed-scope', tx));
    const model = new AbacModel({ stores: [store] });
    await model.init(fakeModelInitContext({ permissions: reg }));
    expect(model.capabilities.sync).to.equal('never');
    const ctx = fakeEvaluationContext({ now: NOW, permissions: reg, conditions: new DefaultConditionCompiler() });
    const req = { principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW } };
    expect((await model.evaluate(req, ctx)).permitWhen).to.equal(FALSE);
    const { tags } = await write((tx) => store.put({ id: 'open', effect: 'permit', permissions: ['file:read'] }, alice, tx, NOW));
    model.invalidate(tags);
    expect((await model.evaluate(req, ctx)).permitWhen).to.equal(TRUE);
  });

  it('refuses a row whose JSON is broken, naming it', async () => {
    await raw(driver, `INSERT INTO ${AUTHZ_POLICY_TABLE} (id, effect, permissions, scope_type, scope_id, created_at) VALUES ('broken', 'permit', '[oops', '$global', '', '2026-10-01T00:00:00.000Z')`);
    let error: unknown;
    await new DbPolicyStore(driver).load().catch((e) => (error = e));
    expect((error as Error).message).to.match(/authz_policy "broken": column permissions is not JSON/);
  });
});
