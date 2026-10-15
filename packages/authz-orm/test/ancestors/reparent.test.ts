import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, Parent, reparent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable } from '../support/ancestors.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[]): Promise<unknown> };

describe('reparent', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
    await (await testHost.domains()).service('root');
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await createAncestorTable(db, 'sqlite');
  });

  afterEach(async () => {
    await db.clear();
    await dropAncestorTable(db, 'sqlite');
  });

  it('moves the rows and their subtrees in one transaction', async () => {
    const Folder = (await db.define({ name: 'Folder', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('folder')(c); Parent('project')(p, 'project_id'); } })) as M;
    const Doc = (await db.define({ name: 'Doc', columns: { folder_id: 'TEXT' }, decorate: (c, p) => { AccessResource('doc')(c); Parent('folder')(p, 'folder_id'); } })) as M;
    await Folder.insert([{ id: 'f1', project_id: 'p1' }, { id: 'f2', project_id: 'p1' }]);
    await Doc.insert({ id: 'd1', folder_id: 'f1' });
    expect(await reparent(Folder as never, ['f1', 'f2'], 'p2')).to.equal(2);
    expect(await ancestorLinks(db.driver())).to.deep.equal(['doc:d1>folder:f1@1', 'doc:d1>project:p2@2', 'folder:f1>project:p2@1', 'folder:f2>project:p2@1']);
    expect(await reparent(Folder as never, [], 'p3')).to.equal(0);
  });

  it('needs the column when the model has several parents, and refuses an unknown one', async () => {
    const Task = (await db.define({ name: 'Task', columns: { project_id: 'TEXT', sprint_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); Parent('sprint', { nullable: true })(p, 'sprint_id'); } })) as M;
    await Task.insert({ id: 't1', project_id: 'p1', sprint_id: 's1' });
    let err: unknown;
    try {
      await reparent(Task as never, ['t1'], 's2');
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(await reparent(Task as never, ['t1'], null, 'sprint_id')).to.equal(1);
    expect(await ancestorLinks(db.driver())).to.deep.equal(['task:t1>project:p1@1']);
    try {
      await reparent(Task as never, ['t1'], 'x', 'nope');
      expect.fail('expected AuthzConfigError');
    } catch (e) {
      expect(e).to.be.instanceOf(AuthzConfigError);
    }
  });
});
