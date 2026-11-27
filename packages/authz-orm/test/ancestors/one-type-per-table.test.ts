import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { ModelBase, Primary } from '@spinajs/orm';

import { AuthzOrmContributor } from '../../src/contributor.js';
import { AccessResource, Parent } from '../../src/index.js';
import { entryOf, unregisterResource } from '../../src/registry.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

const boot = (): Promise<unknown> => new AuthzOrmContributor().contribute('root').then(() => undefined, (e: unknown) => e);

type M = typeof ModelBase & { insert(v: object): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> } };

const settle = async (fn: () => PromiseLike<unknown>): Promise<unknown> => {
  try {
    return await fn();
  } catch (e) {
    return e;
  }
};

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

  it('refuses a type without @Parent on the table of a type with one: a move through it would leave the other type behind', async () => {
    const Task = await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    await db.define({ name: 'Note', columns: {}, table: db.table(Task), decorate: (c) => AccessResource('note')(c) });

    expect(await boot()).to.be.instanceOf(AuthzConfigError).with.property('message').that.contains(`map to one table '${db.table(Task)}'`);
  });

  it('refuses two types whose table names differ only in letter case, which SQLite reads as one table', async () => {
    const Task = await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    await db.define({ name: 'Item', columns: {}, table: db.table(Task).toUpperCase(), decorate: (c, p) => { AccessResource('item')(c); Parent('project')(p, 'project_id'); } });

    expect(await boot()).to.be.instanceOf(AuthzConfigError).with.property('message').that.contains(`map to one table '${db.table(Task)}'`);
  });

  it('refuses at first use a second type registered on the table after the boot, through either class', async () => {
    const Task = (await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } })) as M;
    expect(await boot()).to.equal(undefined);
    expect(entryOf(Task)?.type).to.equal('task');

    const Item = (await db.define({ name: 'Item', columns: {}, table: db.table(Task), decorate: (c, p) => { AccessResource('item')(c); Parent('project')(p, 'project_id'); } })) as M;
    const refused = `map to one table '${db.table(Task)}'`;
    expect(() => entryOf(Item)).to.throw(AuthzConfigError, refused);
    expect(() => entryOf(Task)).to.throw(AuthzConfigError, refused);
    expect(await settle(() => Item.update({ project_id: 'p2' }).where('id', 't1'))).to.be.instanceOf(AuthzConfigError).with.property('message').that.contains(refused);
    expect(await settle(() => Task.insert({ id: 't1', project_id: 'p1' }))).to.be.instanceOf(AuthzConfigError).with.property('message').that.contains(refused);
  });

  it('refuses at first use an unregistered subclass of one type mapped to the table of another', async () => {
    const Task = await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    const Item = await db.define({ name: 'Item', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('item')(c); Parent('project')(p, 'project_id'); } });
    const ItemOnTasks = await db.define({ name: 'ItemOnTasks', columns: {}, base: Item, table: db.table(Task) });

    expect(await boot()).to.equal(undefined);
    expect(() => entryOf(ItemOnTasks)).to.throw(AuthzConfigError, `map to one table '${db.table(Task)}'`);
    expect(entryOf(Task)?.type).to.equal('task');
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
