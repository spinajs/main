import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { ModelBase, Primary } from '@spinajs/orm';

import { AuthzOrmContributor } from '../../src/contributor.js';
import { AccessResource, Parent } from '../../src/index.js';
import { unregisterResource } from '../../src/registry.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

const boot = (): Promise<unknown> => new AuthzOrmContributor().contribute('root').then(() => undefined, (e: unknown) => e);

describe('authz-orm: one resource type per table', function () {
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

  it('refuses at domain boot two resource types on one table, naming both classes, both types and the table', async () => {
    const Task = await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    const Item = await db.define({ name: 'Item', columns: {}, table: db.table(Task), decorate: (c, p) => { AccessResource('item')(c); Parent('project')(p, 'project_id'); } });
    const table = db.table(Task);

    const error = await boot();
    expect(error).to.be.instanceOf(AuthzConfigError).with.property('message', `authz-orm: @AccessResource models ${Task.name} (resource 'task') and ${Item.name} (resource 'item') map to one table '${table}'; a write keeps authz_resource_ancestor for the written model's type only and a rebuild writes every row of the table as both types, so the links of one type go stale: use one resource type per table (register both classes as 'task'), or map 'item' to a table of its own`);

    const domainBoot = await (await testHost.domains()).service('root').then(() => undefined, (e: unknown) => e);
    try {
      expect(domainBoot).to.be.instanceOf(AuthzConfigError).with.property('message').that.contains(`map to one table '${table}'`);
    } finally {
      await testHost.resetRoot();
    }
  });

  it('boots two classes of one type on one table: a second class, and a registered subclass on its parent table', async () => {
    const Doc = await db.define({ name: 'Doc', columns: { folder_id: 'TEXT' }, decorate: (c, p) => { AccessResource('doc')(c); Parent('folder')(p, 'folder_id'); } });
    await db.define({ name: 'DocView', columns: {}, table: db.table(Doc), decorate: (c) => AccessResource('doc')(c) });
    await db.define({ name: 'SignedDoc', columns: {}, base: Doc, table: db.table(Doc), decorate: (c) => AccessResource('doc')(c) });

    expect(await boot()).to.equal(undefined);
  });

  it('boots one type spread over two tables', async () => {
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    await db.define({ name: 'ArchivedTask', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });

    expect(await boot()).to.equal(undefined);
  });

  it('boots resource types whose classes map to no table yet', async () => {
    class Draft extends ModelBase {
      @Primary() public id: string;
    }
    class Sketch extends ModelBase {
      @Primary() public id: string;
    }
    AccessResource('draft')(Draft);
    AccessResource('sketch')(Sketch);
    try {
      expect(await boot()).to.equal(undefined);
    } finally {
      unregisterResource(Draft);
      unregisterResource(Sketch);
    }
  });
});
