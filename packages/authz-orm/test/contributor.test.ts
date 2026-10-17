import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AuthzOrmContributor, checkResourceConnections, storesConnection } from '../src/contributor.js';
import { AccessResource, Parent } from '../src/index.js';
import { TestDb } from './support/db.js';

const expect = chai.expect;

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
    sinon.restore();
    await db.clear();
  });

  it('reads the stores connection like authz-rbac', () => {
    expect(storesConnection({})).to.deep.equal({ name: 'default', key: 'the ORM default connection' });
    expect(storesConnection({ admin: 'admin' })).to.deep.equal({ name: 'admin', key: 'authz.admin.connection' });
    expect(storesConnection({ admin: 'admin', rbac: 'rbac' })).to.deep.equal({ name: 'rbac', key: 'authz.rbac.connection' });
  });

  it('passes when every @AccessResource model is on the stores connection, refuses any that is not, @Parent or not', async () => {
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    await db.define({ name: 'Plain', columns: { title: 'TEXT' }, decorate: (c) => AccessResource('plain')(c) });
    const sqlite = db.driver();
    const other = { Options: { Name: 'other' } } as unknown as OrmDriver;
    const orm = { Connections: new Map<string, OrmDriver>([['default', sqlite], ['sqlite', sqlite], ['other', other]]) } as unknown as Orm;
    expect(() => checkResourceConnections(orm, {})).to.not.throw();
    expect(() => checkResourceConnections(orm, { rbac: 'other' })).to.throw(AuthzConfigError, /@AccessResource models must use the authz stores' connection "other" \(authz\.rbac\.connection\).*Task_\d+_\d+ \(connection "sqlite"\), Plain_\d+_\d+ \(connection "sqlite"\)/);
    expect(() => checkResourceConnections(orm, { rbac: 'nope' })).to.throw(AuthzConfigError, /no ORM connection named "nope"/);
  });

  it('is a contributor the domain boot runs, giving the @AccessResource types as listTypes', async () => {
    expect(DI.getRegisteredTypes(AuthzContributor)).to.include(AuthzOrmContributor);
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    const out = await (await DI.resolve(AuthzOrmContributor)).contribute('root');
    expect(Object.keys(out)).to.deep.equal(['listTypes']);
    expect(out.listTypes).to.include('task');
    await (await testHost.domains()).service('root');
    await testHost.resetRoot();
  });

  it('checks the configured stores connection once the ORM is resolved', async () => {
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c) => AccessResource('task')(c) });
    const contributor = await DI.resolve(AuthzOrmContributor);
    const cfg = testHost.config();
    cfg.set('authz.rbac.connection', 'nope');
    try {
      expect(() => contributor.contribute('root')).to.throw(AuthzConfigError, /authz\.rbac\.connection gives "nope"/);
    } finally {
      cfg.unset('authz.rbac.connection');
    }
  });

  it('gives listTypes even when the ORM is not resolved at domain boot, skipping only the connection check', async () => {
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c) => AccessResource('task')(c) });
    const isResolved = DI.RootContainer.isResolved.bind(DI.RootContainer);
    sinon.stub(DI.RootContainer, 'isResolved').callsFake(((t: unknown) => (t === Orm ? false : isResolved(t as never))) as never);
    // A connection the check would refuse: it must not run without the ORM.
    const cfg = testHost.config();
    cfg.set('authz.rbac.connection', 'nope');
    try {
      const out = await (await DI.resolve(AuthzOrmContributor)).contribute('root');
      expect(out.listTypes).to.include('task');
    } finally {
      cfg.unset('authz.rbac.connection');
    }
  });
});
