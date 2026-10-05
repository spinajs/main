import * as chai from 'chai';
import 'mocha';

import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AccessDenied, AuthorizationModel, AuthzContributor, GLOBAL, runWithPrincipal } from '@spinajs/authz';
import type { Assignment, AuthzService, Principal } from '@spinajs/authz';
import { AccessResource, Owner } from '@spinajs/authz-orm';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';

const expect = chai.expect;

// The 2.x ActiveRole is `ceiling.roles` (B07, D14). The authz-orm suite pins that the ORM passes the
// ceiling through; here the real RbacModel applies it and the ORM middleware enforces the result.
const TYPE = 'ActiveRoleDoc';
const TABLE = `active_role_doc_${process.pid}`;

const role = (name: string, grants: RoleDef['grants']): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants });
const hold = (id: string, ...roles: string[]): Assignment[] => roles.map((r) => ({ id: `${id}-${r}`, subject: { type: 'user', id }, role: r, scope: GLOBAL, source: 'test' }));

// admin: read any; normal: read own; guest: nothing on this type.
const ROLES: RoleDef[] = [role('admin', [{ permission: `${TYPE}:read` }]), role('normal', [{ permission: `${TYPE}:read`, relation: 'owner' }]), role('guest', [{ permission: 'unrelated:read' }])];
const ASSIGNMENTS: Assignment[] = [...hold('admin-and-normal', 'admin', 'normal'), ...hold('admin-and-guest', 'admin', 'guest'), ...hold('normal-only', 'normal')];

const switched = (id: string, roles?: string[]): Principal => userPrincipal(id, roles ? { ceiling: { roles } } : {});
const as = <T>(p: Principal, fn: () => T | Promise<T>): Promise<T> => runWithPrincipal(p, async () => fn());

describe('ActiveRole through the real RbacModel and the ORM middleware', function () {
  this.timeout(60000);

  let orm: Orm;
  let driver: OrmDriver;
  let Doc: typeof ModelBase & { where(...a: unknown[]): any };
  let ownsInstall = false;
  let service: AuthzService;
  const undo: (() => void | Promise<void>)[] = [];
  const caseUndo: (() => void | Promise<void>)[] = [];
  const raw = (sql: string, params: unknown[] = []): Promise<any> => (driver as unknown as { executeOnDb(s: string, p: unknown[], c: QueryContext): Promise<any> }).executeOnDb(sql, params, QueryContext.Select);

  before(async () => {
    try {
      testHost.config();
    } catch {
      await testHost.installHost();
      ownsInstall = true;
    }
    const cfg = testHost.config();
    const before = { logger: cfg.get<unknown>('logger'), db: cfg.get<unknown>('db') };
    cfg.set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
    cfg.set('db', { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }] });
    undo.push(() => {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) cfg.unset(k);
        else cfg.set(k, v);
      }
    });

    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.RootContainer.uncache(Orm);
    orm = await DI.resolve(Orm);
    driver = orm.Connections.get('sqlite')!;
    // Root boots before the type is registered, so the test domain's config carries the permissions.
    await (await testHost.domains()).service('root');

    const name = `ActiveRoleDocModel${process.pid}`;
    const cls = { [name]: class extends ModelBase {} }[name] as typeof ModelBase & (new () => ModelBase);
    Primary()(cls.prototype, 'id');
    AccessResource(TYPE)(cls);
    Owner()(cls.prototype, 'UserId');
    Connection('sqlite')(cls);
    Model(TABLE)(cls);
    await raw(`CREATE TABLE "${TABLE}" ("id" TEXT PRIMARY KEY, "UserId" TEXT, "Value" TEXT)`);
    const internals = orm as unknown as { registerModel(m: unknown): void; applyModelMixins(): void; wireRelations(): void };
    internals.registerModel(cls);
    internals.wireRelations();
    internals.applyModelMixins();
    await orm.reloadTableInfo();
    Doc = cls as typeof Doc;
    undo.push(() => {
      const models = orm.Models as { type: unknown }[];
      const i = models.findIndex((x) => x.type === cls);
      if (i >= 0) models.splice(i, 1);
      DI.RootContainer.Registry.unregister(cls);
    });
  });

  after(async () => {
    for (const fn of undo.splice(0).reverse()) await fn();
    await raw(`DROP TABLE IF EXISTS "${TABLE}"`);
    DI.RootContainer.uncache(Orm);
    await orm.dispose();
    if (ownsInstall) await testHost.uninstallHost();
  });

  beforeEach(async () => {
    await raw(`DELETE FROM "${TABLE}"`);
    await raw(`INSERT INTO "${TABLE}" ("id", "UserId", "Value") VALUES ('mine', 'admin-and-normal', 'mine'), ('theirs', 'someone-else', 'theirs')`);

    const ds = await testHost.domains();
    const name = `activeRole${Date.now()}`;
    const config = testHost.config();
    const set = (path: string[], value: unknown) => {
      const previous = config.get<unknown>(path);
      config.set(path, value);
      caseUndo.push(() => (previous === undefined ? config.unset(path) : config.set(path, previous)));
    };
    set(['authz', 'domains', name], { permissions: { [`${TYPE}:read`]: { types: [TYPE] }, 'unrelated:read': {} }, combine: { default: { algorithm: 'deny-overrides', models: ['rbac'] } }, cache: { maxEntries: 0 } });
    set(['authz', 'orm', 'domain'], name);
    const container = ds.create(name, 'root');
    caseUndo.push(() => (ds.names().includes(name) ? container.dispose() : undefined));
    const model = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(ASSIGNMENTS), log: { warn: () => undefined } });
    container.register(testHost.instance(model)).as(AuthorizationModel);
    container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
    service = await ds.service(name);
  });

  afterEach(async () => {
    for (const fn of caseUndo.splice(0).reverse()) await fn();
  });

  // runAs preloads the principal, so the model answers synchronously and toDB sees its residual.
  const asPreloaded = <T>(p: Principal, fn: () => T | Promise<T>): Promise<T> => service.runAs(p, 'active role test', async () => fn());
  const sqlOf = async (p: Principal) => (await asPreloaded(p, () => Doc.where('id', '>', '').toDB())) as { expression: string; bindings?: unknown[] };
  // Ids come from running the compiled SQL: model hydration of this ad hoc model reads null columns after some other suites.
  const valuesOf = async (p: Principal): Promise<string[]> => {
    const rows = (await as(p, () => Doc.where('id', '>', ''))) as unknown[];
    const { expression, bindings } = await sqlOf(p);
    const ids = ((await raw(expression, bindings ?? [])) as { id: string }[]).map((r) => r.id).sort();
    expect(rows).to.have.length(ids.length);
    return ids;
  };
  const denied = async (p: Principal) => {
    let error: unknown;
    try {
      await as(p, () => Doc.where('id', '>', ''));
    } catch (e) {
      error = e;
    }
    return error;
  };

  it('without a ceiling the full role list applies and admin absorbs normal', async () => {
    const p = switched('admin-and-normal');
    expect(await valuesOf(p)).to.deep.equal(['mine', 'theirs']);
    expect((await sqlOf(p)).expression).to.not.match(/UserId/i);
  });

  it('a switch to the held admin role reads everything with no owner filter', async () => {
    const p = switched('admin-and-normal', ['admin']);
    expect(await valuesOf(p)).to.deep.equal(['mine', 'theirs']);
    expect((await sqlOf(p)).expression).to.not.match(/UserId/i);
  });

  it('a switch to the held narrower role narrows to the owner filter', async () => {
    const p = switched('admin-and-normal', ['normal']);
    const { expression, bindings } = await sqlOf(p);
    expect(expression).to.match(/UserId/i);
    expect(bindings).to.include('admin-and-normal');
    expect(await valuesOf(p)).to.deep.equal(['mine']);
  });

  it('a switch to a held role without a grant on the type is AccessDenied', async () => {
    const error = await denied(switched('admin-and-guest', ['guest']));
    expect(error).to.be.instanceOf(AccessDenied);
    expect((error as AccessDenied).decision.reason?.code).to.equal('no_access');
  });

  it('a switch to a role the user does not hold never widens access (B07)', async () => {
    expect(await denied(switched('normal-only', ['admin']))).to.be.instanceOf(AccessDenied);
  });

  it('a ceiling that leaves no held role is AccessDenied, also with an empty list', async () => {
    expect(await denied(switched('normal-only', ['admin', 'ghost']))).to.be.instanceOf(AccessDenied);
    expect(await denied(switched('normal-only', []))).to.be.instanceOf(AccessDenied);
  });

  it('a ceiling listing a held and an unheld role keeps only the held one', async () => {
    const p = switched('normal-only', ['admin', 'normal']);
    expect(await valuesOf(p)).to.deep.equal([]);
    expect((await sqlOf(p)).expression).to.match(/UserId/i);
  });
});
