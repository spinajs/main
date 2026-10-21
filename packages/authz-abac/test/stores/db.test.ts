import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';
import { AUTHZ_CONNECTION, AuthzAdminFailure, AuthzConfigError, DefaultConditionCompiler, FALSE, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import type { Policy } from '../../src/contracts.js';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import { MIGRATION_DESCRIPTION_SYMBOL, QueryContext, UniqueViolation } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_POLICY_TABLE, AbacModel, AuthzAbac_2026_10_01_00_00_00, DbPolicyStore, PolicyRecord } from '../../src/index.js';
import { DB_KINDS, bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice = userPrincipal('alice');

const policies: Policy[] = [
  { id: 'full', effect: 'deny', permissions: ['file:read', 'file:write'], resourceTypes: ['file'], principalTypes: ['user'], actorTypes: ['agent'], scope: { type: 'org', id: 'o1' }, when: { attr: 'resource.status', eq: 'locked' }, fields: { hide: ['email'] }, reason: 'locked', priority: 100, expiresAt: new Date('2026-12-01T00:00:00.000Z'), source: 'admin' },
  { id: 'plain', effect: 'permit', permissions: ['file:read'], source: 'admin' },
  { id: 'typed-scope', effect: 'permit', permissions: ['file:read'], scope: { type: 'org' }, source: 'admin' },
];

// version() once `policies` are written at NOW; one literal for every driver.
const POLICIES_VERSION = 'edc4435615980e90';

const input = ({ source: _source, ...p }: Policy): Omit<Policy, 'source'> => p;

describe('authz-abac: AuthzAbac migration', () => {
  it('runs on the connection alias authz', () => {
    expect((AuthzAbac_2026_10_01_00_00_00 as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal(AUTHZ_CONNECTION);
  });
});

for (const kind of DB_KINDS) {
  describe(`authz-abac: AuthzAbac migration and DbPolicyStore (${kind})`, function () {
    this.timeout(60_000);

    let db: TestDb;
    let store: DbPolicyStore;

    before(async function () {
      db = await bootDb(this, kind, 'policy_store');
      store = new DbPolicyStore();
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await db.driver.del().from(AUTHZ_POLICY_TABLE);
    });

    const write = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => db.driver.transaction(() => fn({ driver: db.driver })) as Promise<T>;
    const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (err: unknown) => err);
    const putAll = async (): Promise<void> => {
      for (const p of policies) await write((tx) => store.put(input(p), alice, tx, NOW));
    };

    it('creates authz_policy with the design columns, actor_types and priority, and its scope index', async () => {
      const columns = (await db.driver.tableInfo(AUTHZ_POLICY_TABLE)).map((c) => [c.Name, c.Nullable, c.PrimaryKey]);
      expect(columns).to.deep.equal([
        ['id', false, true],
        ['effect', false, false],
        ['permissions', false, false],
        ['resource_types', true, false],
        ['principal_types', true, false],
        ['actor_types', true, false],
        ['scope_type', false, false],
        ['scope_id', false, false],
        ['condition', true, false],
        ['fields', true, false],
        ['reason', true, false],
        ['priority', true, false],
        ['expires_at', true, false],
        ['created_by', true, false],
        ['created_at', false, false],
      ]);
      const indexes = (kind === 'postgres' ? await rawQuery(db.driver, `SELECT indexname AS name FROM pg_indexes WHERE tablename = '${AUTHZ_POLICY_TABLE}' AND schemaname = current_schema()`) : await rawQuery(db.driver, `PRAGMA index_list("${AUTHZ_POLICY_TABLE}")`)) as { name: string }[];
      expect(indexes.map((i) => i.name)).to.include('authz_policy_scope');
    });

    it('round-trips every policy member; writes give the policy tags', async () => {
      const v0 = await store.version();
      for (const p of policies) {
        expect(await write((tx) => store.put(input(p), alice, tx, NOW))).to.deep.equal({ affected: 1, tags: ['policy', `policy:${p.id}`] });
      }
      expect(await store.load()).to.deep.equal(policies.map((p) => ({ ...p, source: 'db' })));
      const [row] = await rawQuery(db.driver, `SELECT created_by FROM ${AUTHZ_POLICY_TABLE} WHERE id = 'full'`);
      expect(row.created_by).to.equal('user:alice');
      expect(await store.version()).to.not.equal(v0);
    });

    it('stores what a policy lacks as SQL NULL', async () => {
      await write((tx) => store.put({ id: 'plain', effect: 'permit', permissions: ['file:read'] }, undefined, tx, NOW));
      const [row] = await rawQuery(db.driver, `SELECT resource_types, principal_types, actor_types, condition, fields, reason, priority, expires_at, created_by FROM ${AUTHZ_POLICY_TABLE} WHERE id = 'plain'`);
      expect(row).to.deep.equal({ resource_types: null, principal_types: null, actor_types: null, condition: null, fields: null, reason: null, priority: null, expires_at: null, created_by: null });
    });

    it('version() hashes what the rows hold, the same on every driver', async () => {
      await putAll();
      expect(await store.version()).to.equal(POLICIES_VERSION);
    });

    it('loads in code-unit order of the ids, whatever the collation', async () => {
      for (const id of ['a', 'B']) await write((tx) => store.put({ id, effect: 'permit', permissions: ['file:read'] }, undefined, tx, NOW));
      expect((await store.load()).map((p) => p.id)).to.deep.equal(['B', 'a']);
    });

    it('replaces on put, deletes by id, and changes its version each time', async () => {
      await putAll();
      const v1 = await store.version();
      await write((tx) => store.put({ id: 'plain', effect: 'deny', permissions: ['file:read'] }, undefined, tx, NOW));
      expect((await store.load()).find((p) => p.id === 'plain')?.effect).to.equal('deny');
      const v2 = await store.version();
      expect(v2).to.not.equal(v1);
      expect(await write((tx) => store.delete('plain', tx))).to.deep.equal({ affected: 1, tags: ['policy', 'policy:plain'] });
      expect(await write((tx) => store.delete('plain', tx))).to.deep.equal({ affected: 0, tags: [] });
      expect(await store.version()).to.not.equal(v2);
    });

    it('writes only inside an AuthzAdmin transaction on the authz connection', async () => {
      const p = { id: 'x', effect: 'permit' as const, permissions: ['file:read'] };
      expect(((await failure(store.put(p, undefined, { driver: db.driver }))) as Error).message).to.equal('DbPolicyStore.put: stores write only inside an AuthzAdmin transaction, and none is in scope');
      expect(((await failure(store.delete('x', { driver: {} }))) as Error).message).to.equal('DbPolicyStore.delete: AuthzTx.driver must be the OrmDriver of an AuthzAdmin transaction');
      const e = await failure(db.second.transaction((driver: OrmDriver) => store.put(p, undefined, { driver }, NOW)));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect((e as Error).message).to.equal('DbPolicyStore.put: the AuthzTx runs on connection "abac-policy_store-second", but authz_policy is on connection "abac-policy_store" (db.Aliases.authz)');
    });

    it('turns a duplicate id from a concurrent writer into a conflict', async () => {
      const insert = sinon.stub(PolicyRecord, 'insert').rejects(new UniqueViolation('duplicate key', { table: AUTHZ_POLICY_TABLE, columns: ['id'] }));
      try {
        const e = await failure(write((tx) => store.put({ id: 'race', effect: 'permit', permissions: ['file:read'] }, undefined, tx, NOW)));
        expect(e).to.be.instanceOf(AuthzAdminFailure);
        expect((e as AuthzAdminFailure).code).to.equal('conflict');
        expect((e as Error).message).to.equal('DbPolicyStore.put: another transaction wrote policy "race" meanwhile; retry');
      } finally {
        insert.restore();
      }
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
      await write((tx) => store.put(input(policies[0]), alice, tx, NOW));
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

    it('refuses a row whose JSON does not parse, naming the table', async () => {
      await rawQuery(db.driver, `INSERT INTO ${AUTHZ_POLICY_TABLE} (id, effect, permissions, scope_type, scope_id, created_at) VALUES ('broken', 'permit', '[oops', '$global', '', '2026-10-01 00:00:00')`, [], QueryContext.Insert);
      const e = await failure(store.load());
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect((e as Error).message).to.match(/^authz_policy: a row holds a JSON column that does not parse \(/);
    });
  });
}
