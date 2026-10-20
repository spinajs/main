import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AuthzOrmContributor, checkResourceConnections } from '../src/contributor.js';
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

  it('passes when every @AccessResource model is on the authz connection, refuses any that is not, @Parent or not', async () => {
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    await db.define({ name: 'Plain', columns: { title: 'TEXT' }, decorate: (c) => AccessResource('plain')(c) });
    const sqlite = db.driver();
    const other = { Options: { Name: 'other' } } as unknown as OrmDriver;
    const on = (authz?: OrmDriver) => ({ Connections: new Map<string, OrmDriver>([['default', sqlite], ['sqlite', sqlite], ['other', other], ...(authz ? [['authz', authz] as [string, OrmDriver]] : [])]) }) as unknown as Orm;
    expect(() => checkResourceConnections(on(sqlite))).to.not.throw();
    expect(() => checkResourceConnections(on(other))).to.throw(AuthzConfigError, /@AccessResource models must use the authz connection "other" \(db\.Aliases\.authz\).*Task_\d+_\d+ \(connection "sqlite"\), Plain_\d+_\d+ \(connection "sqlite"\)/);
    expect(() => checkResourceConnections(on())).to.throw(AuthzConfigError, /no ORM connection answers to "authz"/);
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

  it('gives listTypes even when the ORM is not resolved at domain boot, skipping only the connection check', async () => {
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c) => AccessResource('task')(c) });
    const isResolved = DI.RootContainer.isResolved.bind(DI.RootContainer);
    sinon.stub(DI.RootContainer, 'isResolved').callsFake(((t: unknown) => (t === Orm ? false : isResolved(t as never))) as never);
    // A connection the check would refuse: it must not run without the ORM.
    const cfg = testHost.config();
    cfg.set('authz.rbac.connection', 'nope');
    try {
      const out = await new AuthzOrmContributor().contribute('root');
      expect(out.listTypes).to.include('task');
    } finally {
      cfg.unset('authz.rbac.connection');
    }
  });
});
