import * as chai from 'chai';
import 'mocha';

import { userPrincipal } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, Relation } from '../src/index.js';
import { ormRelations } from '../src/relations.js';
import { TestDb } from './support/db.js';

const expect = chai.expect;

describe('ormRelations', function () {
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

  it('a @Relation column gives a listable resolver that holds for the principal in the column', async () => {
    const Task = (await db.define({
      name: 'Task',
      columns: { assignee_id: 'TEXT' },
      rows: [{ id: 'a', assignee_id: 'alice' }],
      decorate: (cls, proto) => {
        AccessResource('task')(cls);
        Relation('assignee')(proto, 'assignee_id');
      },
    })) as typeof ModelBase;
    void Task;
    const resolver = ormRelations().find((r) => r.type === 'task' && r.relation === 'assignee');
    expect(resolver?.listable).to.equal(true);
    expect(await resolver!.holds(userPrincipal('alice'), { type: 'task', id: 'a' })).to.equal(true);
    expect(await resolver!.holds(userPrincipal('bob'), { type: 'task', id: 'a' })).to.equal(false);
  });
});
