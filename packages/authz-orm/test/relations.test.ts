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

  it('a typed relation holds only when the type column matches too', async () => {
    await db.define({
      name: 'Review',
      columns: { reviewer_id: 'TEXT', reviewer_type: 'TEXT' },
      rows: [{ id: 'r1', reviewer_id: 'bot', reviewer_type: 'agent' }],
      decorate: (cls, proto) => {
        AccessResource('review')(cls);
        Relation('reviewer', { typeColumn: 'reviewer_type' })(proto, 'reviewer_id');
      },
    });
    const resolver = ormRelations().find((r) => r.type === 'review' && r.relation === 'reviewer')!;
    const ref = { type: 'review', id: 'r1' };
    expect(await resolver.holds({ type: 'agent', id: 'bot' } as never, ref)).to.equal(true);
    expect(await resolver.holds(userPrincipal('bot'), ref)).to.equal(false);
  });
});
