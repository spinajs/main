import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { Orm, OrmDriver } from '@spinajs/orm';

import { AuthzOrmContributor, checkResourceConnections, storesConnection } from '../src/contributor.js';
import { AccessResource, Parent } from '../src/index.js';
import { TestDb } from './support/db.js';

const expect = chai.expect;

const config = (values: Record<string, unknown>) => ({ get: <T>(path: string[]) => values[path.join('.')] as T });

describe('authz-orm resource connection check', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.clear();
  });

  it('reads the stores connection like authz-rbac', () => {
    expect(storesConnection(config({}))).to.deep.equal({ name: 'default', key: 'the ORM default connection' });
    expect(storesConnection(config({ 'authz.admin.connection': 'admin' }))).to.deep.equal({ name: 'admin', key: 'authz.admin.connection' });
    expect(storesConnection(config({ 'authz.admin.connection': 'admin', 'authz.rbac.connection': 'rbac' }))).to.deep.equal({ name: 'rbac', key: 'authz.rbac.connection' });
  });

  it('passes when every @AccessResource model is on the stores connection, refuses any that is not, @Parent or not', async () => {
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    await db.define({ name: 'Plain', columns: { title: 'TEXT' }, decorate: (c) => AccessResource('plain')(c) });
    const sqlite = db.driver();
    const other = { Options: { Name: 'other' } } as unknown as OrmDriver;
    const orm = { Connections: new Map<string, OrmDriver>([['default', sqlite], ['sqlite', sqlite], ['other', other]]) } as unknown as Orm;
    expect(() => checkResourceConnections(orm, config({}))).to.not.throw();
    expect(() => checkResourceConnections(orm, config({ 'authz.rbac.connection': 'other' }))).to.throw(AuthzConfigError, /@AccessResource models must use the authz stores' connection "other" \(authz\.rbac\.connection\).*Task_\d+_\d+ \(connection "sqlite"\), Plain_\d+_\d+ \(connection "sqlite"\)/);
    expect(() => checkResourceConnections(orm, config({ 'authz.rbac.connection': 'nope' }))).to.throw(AuthzConfigError, /no ORM connection named "nope"/);
  });

  it('is a contributor the domain boot runs, giving the @AccessResource types as listTypes', async () => {
    expect(DI.getRegisteredTypes(AuthzContributor)).to.include(AuthzOrmContributor);
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    const out = await new AuthzOrmContributor().contribute('root');
    expect(Object.keys(out)).to.deep.equal(['listTypes']);
    expect(out.listTypes).to.include('task');
    await (await testHost.domains()).service('root');
    await testHost.resetRoot();
  });
});
