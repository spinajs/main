import * as chai from 'chai';
import 'mocha';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Orm, OrmDriver } from '@spinajs/orm';
import type { ITransactionOptions } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AdminGuard, AuthorizationModel, AuthzAdminBackend, AuthzAdminFailure, AuthzConfigError, AuthzContributor, MemoryScopeAttributeStore, ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import type { AuthzCommand, Principal, RememberedBatch } from '@spinajs/authz';
import { DbScopeAttributeStore } from '@spinajs/authz-orm';
import { AbacContributor, AbacModel, DbPolicyStore, PolicyStore } from '@spinajs/authz-abac';

import { AuthzAdminIdempotency_2026_10_02_00_01_00, DbAuthzAdminBackend } from '../../../src/index.js';
import { P1, P2, config, failure, installHost, instance, ok, rbacDomain, rejection, resetHost, uninstallHost } from '../support.js';

const expect = chai.expect;

const VERSION = 'authz_version';
const IDEM = 'authz_admin_idempotency';
const ATTRS = 'authz_scope_attribute';
const POLICIES = 'authz_policy';
const ALICE = { type: 'user', id: 'alice' };
const HOUR = 3600_000;

const DB = {
  DefaultConnection: 'sqlite',
  Connections: [
    { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { Table: 'orm_migrations', OnStartup: true } },
    { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'other' },
  ],
};

const batch = (rows: unknown[] = []): RememberedBatch => ({ results: [{ ok: true, kind: 'assignment.grant', id: 'a1', affected: 1 }], rows });

/** Refuses a policy.put whose id is 'refused', inside the transaction. */
export class RefusingGuard extends AdminGuard {
  async check(_actor: Principal, c: AuthzCommand): Promise<void> {
    if (c.kind === 'policy.put' && c.policy.id === 'refused') throw new AuthzAdminFailure('forbidden', 'refused by the test guard');
  }
}

describe('DbAuthzAdminBackend on SQLite', function () {
  this.timeout(30000);

  let orm: Orm;
  let db: OrmDriver;
  const backend = new DbAuthzAdminBackend();
  const attributes = new DbScopeAttributeStore();
  let policies: DbPolicyStore;

  const versionOf = async (domain: string): Promise<number | undefined> => {
    const rows = (await db.select().from(VERSION).where({ domain })) as { version: number }[];
    return rows[0] === undefined ? undefined : Number(rows[0].version);
  };
  const idemRows = async () => (await db.select().from(IDEM)) as Record<string, unknown>[];
  const policyIds = async () => (await policies.load()).map((p) => p.id);

  before(async () => {
    await installHost();
    config().set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
    config().set('db', DB);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    orm = (await DI.resolve(Orm)) as Orm;
    db = orm.Connections.get('default')!;
    // The authz-rbac migration creates authz_version when it runs at boot; create it only when it did not.
    if (!(await db.schema().tableExists(VERSION))) {
      await db.schema().createTable(VERSION, (t) => {
        t.string('domain', 64).notNull().primaryKey();
        t.bigint('version').notNull();
      });
    }
    policies = new DbPolicyStore(db);
  });

  after(async () => {
    for (const c of new Set(orm?.Connections.values() ?? [])) await c.disconnect();
    DI.uncache(Orm);
    DI.unregister(SqliteOrmDriver);
    await uninstallHost();
  });

  // The backend remembers which version rows exist, so each test takes domains it has not seen.
  let n = 0;
  let dom = '';
  let other = '';

  beforeEach(async () => {
    for (const t of [IDEM, ATTRS, POLICIES]) await db.del().from(t);
    config().set(['authz', 'admin', 'connection'], undefined);
    dom = `d${++n}`;
    other = `e${n}`;
  });

  describe('the backend', () => {
    it('the migration registers through @Migration and creates the table with its key and index', async () => {
      expect(orm.Migrations.map((m) => m.name)).to.include(AuthzAdminIdempotency_2026_10_02_00_01_00.name);
      const info = await db.tableInfo(IDEM);
      expect(info.map((c) => c.Name).sort()).to.deep.equal(['actor', 'created_at', 'domain', 'expires_at', 'idem_key', 'results', 'rows']);
      expect(info.filter((c) => c.PrimaryKey).map((c) => c.Name)).to.deep.equal(['domain', 'actor', 'idem_key']);
      const indexes = (await db.select().from('sqlite_master').where({ type: 'index', tbl_name: IDEM })) as { name: string; sql: string | null }[];
      expect(indexes.filter((i) => i.sql?.includes('expires_at')).length).to.equal(1);
    });

    it('is registered under AuthzAdminBackend, but the default stays MemoryAuthzAdminBackend', () => {
      const names = DI.RootContainer.Registry.getTypesChain(AuthzAdminBackend).map((e) => (e.type as { name?: string }).name);
      expect(names).to.include('DbAuthzAdminBackend');
      expect(names).to.include('MemoryAuthzAdminBackend');
      expect(backend).to.be.instanceOf(AuthzAdminBackend);
    });

    it('runs fn in an ORM transaction on the configured connection and commits both DB stores', async () => {
      const out = await backend.transaction('d1', async (tx) => {
        expect(tx.driver).to.equal(db);
        expect(db.CurrentTransaction).to.not.equal(undefined);
        await attributes.write(P1, { set: { 'a.b': 1 }, remove: [] }, ALICE, tx);
        await policies.put({ id: 'pol', effect: 'permit', permissions: ['file:read'] }, ALICE, tx);
        return 'done';
      });
      expect(out).to.equal('done');
      expect(await attributes.rows(P1)).to.deep.equal({ 'a.b': 1 });
      expect(await policyIds()).to.deep.equal(['pol']);
    });

    it('rolls both DB stores back when fn rejects, and passes the rejection on', async () => {
      await backend.transaction(dom, (tx) => backend.bumpVersion(dom, tx));
      const boom = new Error('boom');
      const e = await rejection(
        backend.transaction(dom, async (tx) => {
          await attributes.write(P1, { set: { x: 1 }, remove: [] }, ALICE, tx);
          await policies.put({ id: 'gone', effect: 'permit', permissions: ['file:read'] }, ALICE, tx);
          await backend.bumpVersion(dom, tx);
          throw boom;
        }),
      );
      expect(e).to.equal(boom);
      expect(await attributes.rows(P1)).to.deep.equal({});
      expect(await policyIds()).to.deep.equal([]);
      expect(await versionOf(dom)).to.equal(1);
    });

    it('bumps authz_version by domain only for committed transactions', async () => {
      await backend.transaction(dom, (tx) => backend.bumpVersion(dom, tx));
      await backend.transaction(dom, (tx) => backend.bumpVersion(dom, tx));
      await backend.transaction(other, (tx) => backend.bumpVersion(other, tx));
      expect(await versionOf(dom)).to.equal(2);
      expect(await versionOf(other)).to.equal(1);
    });

    it('creates the version row at 0 before the first transaction of a domain', async () => {
      expect(await versionOf(dom)).to.equal(undefined);
      await backend.transaction(dom, async () => undefined);
      expect(await versionOf(dom)).to.equal(0);
    });

    it('inserts the version row when it went missing', async () => {
      await backend.transaction(dom, async (tx) => {
        await db.del().from(VERSION).where({ domain: dom });
        await backend.bumpVersion(dom, tx);
      });
      expect(await versionOf(dom)).to.equal(1);
    });

    it('takes the domain lock with its first statement: an UPDATE of the authz_version row', async () => {
      const sqlite = db as unknown as { executeOnDb(stmt: string, params: unknown[], ctx: unknown): Promise<unknown> };
      const original = sqlite.executeOnDb;
      const order: string[] = [];
      sqlite.executeOnDb = function (this: unknown, stmt: string, params: unknown[], ctx: unknown) {
        order.push(stmt);
        return original.call(this, stmt, params, ctx);
      };
      try {
        await backend.transaction('d1', async () => undefined);
      } finally {
        sqlite.executeOnDb = original;
      }
      const begin = order.findIndex((s) => /^BEGIN/i.test(s));
      expect(begin).to.be.greaterThan(-1);
      expect(order[begin + 1]).to.match(/^UPDATE .*authz_version.* WHERE/i);
    });

    it('asks for READ COMMITTED where the driver allows it, and nothing on SQLite', async () => {
      const seen: (ITransactionOptions | undefined)[] = [];
      const original = db.transaction;
      db.transaction = function (this: OrmDriver, cb: never, options?: ITransactionOptions) {
        seen.push(options);
        return original.call(this, cb, options);
      } as typeof db.transaction;
      const levels = Object.getOwnPropertyDescriptor(db, 'SupportedIsolationLevels')!;
      try {
        await backend.transaction('d1', async () => undefined);
        Object.defineProperty(db, 'SupportedIsolationLevels', { ...levels, value: ['SERIALIZABLE', 'READ COMMITTED'] });
        await backend.transaction('d1', async () => undefined);
      } finally {
        Object.defineProperty(db, 'SupportedIsolationLevels', levels);
        db.transaction = original;
      }
      expect(seen).to.deep.equal([undefined, { isolation: 'READ COMMITTED' }]);
    });

    it('runs concurrent transactions one after another on the single SQLite connection', async () => {
      const log: string[] = [];
      const slow = backend.transaction('d1', async (tx) => {
        log.push('a:start');
        await new Promise((r) => setTimeout(r, 30));
        await attributes.write(P1, { set: { a: 1 }, remove: [] }, ALICE, tx);
        await backend.bumpVersion('d1', tx);
        log.push('a:end');
      });
      const fast = backend.transaction('d2', async (tx) => {
        log.push('b:start');
        await attributes.write(P2, { set: { b: 2 }, remove: [] }, ALICE, tx);
        await backend.bumpVersion('d2', tx);
        log.push('b:end');
      });
      await Promise.all([slow, fast]);
      expect(log).to.deep.equal(['a:start', 'a:end', 'b:start', 'b:end']);
      expect(await attributes.rows(P1)).to.deep.equal({ a: 1 });
      expect(await attributes.rows(P2)).to.deep.equal({ b: 2 });
    });

    it('runs on the connection authz.admin.connection names', async () => {
      config().set(['authz', 'admin', 'connection'], 'other');
      const e = await rejection(backend.transaction('d1', async () => undefined));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.include('authz_version').and.include('AuthzRbac_2026_10_01_00_00_00');
      config().set(['authz', 'admin', 'connection'], 'nope');
      expect(await rejection(backend.transaction('d1', async () => undefined))).to.be.instanceOf(AuthzConfigError);
    });

    it('a missing idempotency table names its migration', async () => {
      config().set(['authz', 'admin', 'connection'], 'other');
      const e = await rejection(backend.recall('d1', 'user:alice', 'k', new Date()));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.include(IDEM).and.include(AuthzAdminIdempotency_2026_10_02_00_01_00.name);
    });

    it('a failed read of a table that exists is passed on, not blamed on a migration', async () => {
      const down = new Error('connection lost');
      const select = db.select;
      db.select = (() => {
        throw down;
      }) as unknown as typeof db.select;
      try {
        expect(await rejection(backend.transaction(dom, async () => undefined))).to.equal(down);
      } finally {
        db.select = select;
      }
    });

    it('refuses to run inside a transaction already open on the connection', async () => {
      const inOuter = (fn: () => Promise<unknown>) => rejection(db.transaction(fn));
      const e = await inOuter(() => backend.transaction(dom, async (tx) => attributes.write(P1, { set: { a: 1 }, remove: [] }, ALICE, tx)));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.include('db.transaction');
      expect(await inOuter(() => backend.recall(dom, 'user:alice', 'k', new Date()))).to.be.instanceOf(AuthzConfigError);
      expect(await attributes.rows(P1)).to.deep.equal({});
      expect(await versionOf(dom)).to.equal(undefined);
    });

    it('a lock that finds no row inserts the row first and takes the lock on it', async () => {
      await backend.transaction(dom, async () => undefined);
      await db.del().from(VERSION).where({ domain: dom });
      const seen = await backend.transaction(dom, () => versionOf(dom));
      expect(seen).to.equal(0);
      expect(await versionOf(dom)).to.equal(0);
    });

    it('recall sweeps expired rows of its own domain only', async () => {
      const now = new Date();
      await backend.transaction(dom, (tx) => backend.remember(dom, 'user:alice', 'k', batch(), new Date(now.getTime() + HOUR), tx));
      await backend.transaction(other, (tx) => backend.remember(other, 'user:alice', 'k', batch(), new Date(now.getTime() + HOUR), tx));
      expect(await backend.recall(dom, 'user:alice', 'nothing', new Date(now.getTime() + 2 * HOUR))).to.equal(undefined);
      expect((await idemRows()).map((r) => r.domain)).to.deep.equal([other]);
    });

    it('bumpVersion and remember refuse a tx that is not an ORM transaction on the connection', async () => {
      expect(await rejection(backend.bumpVersion('d1', { driver: db }))).to.be.instanceOf(AuthzConfigError);
      expect(await rejection(backend.bumpVersion('d1', { driver: {} }))).to.be.instanceOf(AuthzConfigError);
      expect(await rejection(backend.remember('d1', 'user:alice', 'k', batch(), new Date(Date.now() + HOUR), { driver: db }))).to.be.instanceOf(AuthzConfigError);
      const other = orm.Connections.get('other')!;
      expect(await rejection(other.transaction(() => backend.bumpVersion('d1', { driver: other })))).to.be.instanceOf(AuthzConfigError);
    });

    it('remembers and recalls a batch, with its Dates revived', async () => {
      const expiresAt = new Date('2026-10-10T12:00:00.000Z');
      const createdAt = new Date('2026-10-03T08:30:00.123Z');
      const rows = [{ id: 'a1', expiresAt, createdAt, nested: { at: [createdAt] }, text: '2026-10-03T08:30:00.123Z' }, null];
      const until = new Date(Date.now() + HOUR);
      expect(await backend.transaction('d1', (tx) => backend.remember('d1', 'user:alice', 'k1', batch(rows), until, tx))).to.equal('stored');
      const got = await backend.recall('d1', 'user:alice', 'k1', new Date());
      expect(got).to.deep.equal(batch(rows));
      const row = got!.rows[0] as { expiresAt: Date; createdAt: Date; nested: { at: Date[] }; text: unknown };
      expect(row.expiresAt).to.be.instanceOf(Date);
      expect(row.nested.at[0]).to.be.instanceOf(Date);
      expect(row.text).to.be.a('string');
      expect(await backend.recall('d1', 'user:bob', 'k1', new Date())).to.equal(undefined);
      expect(await backend.recall('d2', 'user:alice', 'k1', new Date())).to.equal(undefined);
      expect(await backend.recall('d1', 'user:alice', 'k2', new Date())).to.equal(undefined);
      const [stored] = await idemRows();
      expect(stored).to.deep.include({ domain: 'd1', actor: 'user:alice', idem_key: 'k1' });
      expect(stored.created_at).to.not.equal(null);
    });

    it('a key stored first is "exists", and a rolled back remember leaves nothing', async () => {
      const until = new Date(Date.now() + HOUR);
      await backend.transaction('d1', (tx) => backend.remember('d1', 'user:alice', 'k1', batch(), until, tx));
      expect(await backend.transaction('d1', (tx) => backend.remember('d1', 'user:alice', 'k1', batch([{ other: true }]), until, tx))).to.equal('exists');
      await backend
        .transaction('d1', async (tx) => {
          await backend.remember('d1', 'user:alice', 'k2', batch(), until, tx);
          throw new Error('roll back');
        })
        .catch(() => undefined);
      expect((await idemRows()).map((r) => r.idem_key)).to.deep.equal(['k1']);
      expect((await backend.recall('d1', 'user:alice', 'k1', new Date()))?.rows).to.deep.equal([]);
    });

    it('recall ignores and deletes expired rows', async () => {
      const now = new Date();
      await backend.transaction('d1', async (tx) => {
        await backend.remember('d1', 'user:alice', 'old', batch(), new Date(now.getTime() + HOUR), tx);
        await backend.remember('d1', 'user:alice', 'live', batch(), new Date(now.getTime() + 3 * HOUR), tx);
      });
      const later = new Date(now.getTime() + 2 * HOUR);
      expect(await backend.recall('d1', 'user:alice', 'old', later)).to.equal(undefined);
      expect((await idemRows()).map((r) => r.idem_key)).to.deep.equal(['live']);
      expect(await backend.recall('d1', 'user:alice', 'live', later)).to.not.equal(undefined);
    });

    it('remember replaces a row past its expiry', async () => {
      await db
        .insert()
        .into(IDEM)
        .values({ domain: 'd1', actor: 'user:alice', idem_key: 'k1', results: '[]', rows: '[]', expires_at: new Date(Date.now() - HOUR), created_at: new Date(Date.now() - 25 * HOUR) });
      const until = new Date(Date.now() + HOUR);
      expect(await backend.transaction('d1', (tx) => backend.remember('d1', 'user:alice', 'k1', batch([{ id: 'new' }]), until, tx))).to.equal('stored');
      expect((await backend.recall('d1', 'user:alice', 'k1', new Date()))?.rows).to.deep.equal([{ id: 'new' }]);
    });

    it('refuses a key or an actor longer than its column, and a domain longer than 64', async () => {
      const until = new Date(Date.now() + HOUR);
      const code = async (p: Promise<unknown>) => {
        const e = await rejection(p);
        expect(e).to.be.instanceOf(AuthzAdminFailure);
        return [(e as AuthzAdminFailure).code, (e as AuthzAdminFailure).field];
      };
      expect(await code(backend.recall('d1', 'user:alice', 'k'.repeat(161), new Date()))).to.deep.equal(['invalid_batch', 'idempotencyKey']);
      expect(await code(backend.transaction('d1', (tx) => backend.remember('d1', 'user:alice', 'k'.repeat(161), batch(), until, tx)))).to.deep.equal(['invalid_batch', 'idempotencyKey']);
      expect(await code(backend.recall('d1', `user:${'u'.repeat(96)}`, 'k', new Date()))).to.deep.equal(['invalid_batch', 'idempotencyKey']);
      // 160 characters fit, counted as characters, not UTF-16 units.
      expect(await backend.recall('d1', 'user:alice', '\u{1F600}'.repeat(160), new Date())).to.equal(undefined);
      expect(await rejection(backend.transaction('d'.repeat(65), async () => undefined))).to.be.instanceOf(AuthzConfigError);
      expect(await rejection(backend.recall('d'.repeat(65), 'user:alice', 'k', new Date()))).to.be.instanceOf(AuthzConfigError);
    });
  });

  describe('AuthzAdmin.execute over the DB backend', () => {
    const TYPES = ['org', 'project', 'file', 'group'];
    const SCHEMA = { scopeType: 'project', schema: { type: 'object', properties: { settings: { type: 'object' } }, additionalProperties: false }, defaults: {} };
    const alice = { type: 'user', id: 'alice' } as Principal;

    afterEach(async () => {
      await resetHost();
    });

    async function domain(admin: Record<string, unknown> = { guard: { service: 'RefusingGuard' }, backend: 'DbAuthzAdminBackend' }) {
      const model = new AbacModel({ stores: [policies] });
      return rbacDomain(dom, {
        admin,
        without: ['assignments', 'links', 'rules'],
        permissions: { 'authz:scope.manage': { types: TYPES }, 'authz:policies.manage': { types: TYPES } },
        register(c) {
          c.register(RefusingGuard).as(AdminGuard);
          c.register(instance(attributes)).as(ScopeAttributeStore);
          c.register(instance(attributes)).as(WritableScopeAttributeStore);
          c.register(instance(policies)).as(PolicyStore);
          c.register(instance(model)).as(AuthorizationModel);
          c.register(instance(new AbacContributor(model))).as(AuthzContributor);
          c.register(instance({ contribute: () => ({ scopeAttributeSchemas: [SCHEMA] }) })).as(AuthzContributor);
        },
      });
    }

    const setAttrs = (scope = P1, settings: Record<string, unknown> = { mode: 'strict' }): AuthzCommand => ({ kind: 'scope.setAttributes', scope, patch: { settings } });
    const putPolicy = (id: string, scope = P1): AuthzCommand => ({ kind: 'policy.put', policy: { id, effect: 'permit', permissions: ['file:read'], scope } });

    it('commits scope.setAttributes and policy.put in one transaction and bumps the version', async () => {
      const d = await domain();
      const results = ok(await d.admin.execute(alice, [setAttrs(), putPolicy('p-1')]));
      expect(results.map((r) => r.kind)).to.deep.equal(['scope.setAttributes', 'policy.put']);
      expect(await attributes.get(P1)).to.deep.equal({ settings: { mode: 'strict' } });
      expect(await policyIds()).to.deep.equal(['p-1']);
      expect(await versionOf(dom)).to.equal(1);
      expect(d.bus.published.at(-1)?.tags).to.include('scope:project:p1');
    });

    it('a batch that fails in the transaction leaves nothing behind', async () => {
      const d = await domain();
      ok(await d.admin.execute(alice, [putPolicy('p-1')]));
      const results = await d.admin.execute(alice, [setAttrs(P2), putPolicy('p-2', P2), putPolicy('refused', P2)]);
      expect(failure(results)).to.deep.equal({ at: 2, code: 'forbidden' });
      expect(await attributes.rows(P2)).to.deep.equal({});
      expect(await policyIds()).to.deep.equal(['p-1']);
      expect(await versionOf(dom)).to.equal(1);
    });

    it('scope.forget removes the attributes and policies at the node', async () => {
      const d = await domain();
      ok(await d.admin.execute(alice, [setAttrs(P1), putPolicy('at-p1'), putPolicy('at-p2', P2), setAttrs(P2)]));
      const [forgot] = ok(await d.admin.execute(alice, [{ kind: 'scope.forget', scope: P1 }]));
      expect(forgot.affected).to.equal(2);
      expect(await attributes.rows(P1)).to.deep.equal({});
      expect(await attributes.rows(P2)).to.deep.equal({ 'settings.mode': 'strict' });
      expect(await policyIds()).to.deep.equal(['at-p2']);
      expect(await versionOf(dom)).to.equal(2);
    });

    it('replays a batch by its idempotency key without writing again', async () => {
      const d = await domain();
      const first = await d.admin.execute(alice, [setAttrs(), putPolicy('p-1')], { idempotencyKey: 'k1' });
      ok(first);
      const again = await d.admin.execute(alice, [setAttrs(P1, { mode: 'loose' }), putPolicy('p-2')], { idempotencyKey: 'k1' });
      expect(again).to.deep.equal(first);
      expect(await attributes.get(P1)).to.deep.equal({ settings: { mode: 'strict' } });
      expect(await policyIds()).to.deep.equal(['p-1']);
      expect(await versionOf(dom)).to.equal(1);
      expect((await idemRows()).map((r) => [r.domain, r.actor, r.idem_key])).to.deep.equal([[dom, 'user:alice', 'k1']]);
      const tooLong = await rejection(d.admin.execute(alice, [setAttrs()], { idempotencyKey: 'k'.repeat(161) }));
      expect(tooLong).to.be.instanceOf(AuthzAdminFailure);
      expect((tooLong as AuthzAdminFailure).code).to.equal('invalid_batch');
    });

    it('concurrent batches of one domain both commit', async () => {
      const d = await domain();
      const [a, b] = await Promise.all([d.admin.execute(alice, [setAttrs(P1), putPolicy('c-1')]), d.admin.execute(alice, [setAttrs(P2), putPolicy('c-2', P2)])]);
      ok(a);
      ok(b);
      expect((await policyIds()).sort()).to.deep.equal(['c-1', 'c-2']);
      expect(await versionOf(dom)).to.equal(2);
    });

    it('refuses a batch inside an open transaction and writes nothing', async () => {
      const d = await domain();
      const e = await rejection(db.transaction(() => d.admin.execute(alice, [setAttrs(), putPolicy('nested')])));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(await attributes.rows(P1)).to.deep.equal({});
      expect(await policyIds()).to.deep.equal([]);
      expect(d.bus.published).to.deep.equal([]);
    });

    it('a dry run returns the results and commits nothing', async () => {
      const d = await domain();
      const results = ok(await d.admin.execute(alice, [setAttrs(), putPolicy('dry')], { dryRun: true }));
      expect(results.map((r) => r.kind)).to.deep.equal(['scope.setAttributes', 'policy.put']);
      expect(await attributes.rows(P1)).to.deep.equal({});
      expect(await policyIds()).to.deep.equal([]);
      expect(await versionOf(dom)).to.equal(0);
      expect(await idemRows()).to.deep.equal([]);
    });

    it('a key another batch stored after the recall rolls the batch back and replays the stored results', async () => {
      const d = await domain();
      const stored = [{ ok: true, kind: 'scope.setAttributes', affected: 9 }];
      await db
        .insert()
        .into(IDEM)
        .values({ domain: dom, actor: 'user:alice', idem_key: 'k1', results: JSON.stringify(stored), rows: '[null]', expires_at: new Date(Date.now() + HOUR), created_at: new Date() });
      const shared = (await DI.resolve(DbAuthzAdminBackend)) as DbAuthzAdminBackend;
      const recall = shared.recall;
      let calls = 0;
      shared.recall = function (this: DbAuthzAdminBackend, ...args: Parameters<DbAuthzAdminBackend['recall']>) {
        return calls++ === 0 ? Promise.resolve(undefined) : recall.apply(this, args);
      };
      try {
        expect(await d.admin.execute(alice, [setAttrs()], { idempotencyKey: 'k1' })).to.deep.equal(stored);
      } finally {
        shared.recall = recall;
      }
      expect(calls).to.equal(2);
      expect(await attributes.rows(P1)).to.deep.equal({});
      expect(await versionOf(dom)).to.equal(0);
    });

    it('without authz.admin.backend the memory backend runs the batch', async () => {
      const d = await domain({ guard: { service: 'RefusingGuard' } });
      const memory = new MemoryScopeAttributeStore();
      d.container.register(instance(memory)).as(WritableScopeAttributeStore);
      ok(await d.admin.execute(alice, [setAttrs()]));
      expect(await memory.get(P1)).to.deep.equal({ settings: { mode: 'strict' } });
      expect(await versionOf(dom)).to.equal(undefined);
    });
  });
});
