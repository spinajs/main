import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { ModelBase, Primary } from '@spinajs/orm';

import { AccessResource, Relation, entryOf, registerAccessResource } from '../src/index.js';
import { resetRegistry } from '../src/registry.js';

const expect = chai.expect;

describe('@Relation', () => {
  afterEach(() => resetRegistry());

  it('declares a named column relation, with an optional type column', () => {
    @AccessResource('task')
    class Task extends ModelBase {
      @Primary() public id: number;
      @Relation('assignee') public assignee_id: string;
      @Relation('reviewer', { typeColumn: 'reviewer_type' }) public reviewer_id: string;
    }
    expect(entryOf(Task)?.relations).to.deep.equal({ assignee: { column: 'assignee_id' }, reviewer: { column: 'reviewer_id', typeColumn: 'reviewer_type' } });
  });

  it('refuses owner, self and malformed names', () => {
    expect(() => Relation('owner')).to.throw(AuthzConfigError, /@Owner\(\)/);
    expect(() => Relation('self')).to.throw(AuthzConfigError, /@Self\(\)/);
    expect(() => Relation('9lives')).to.throw(AuthzConfigError, /relation name/);
  });

  it('registers relations for a model the package does not own, and refuses a conflicting column', () => {
    class Job extends ModelBase {
      @Primary() public id: number;
    }
    registerAccessResource(Job, 'job', { relations: { assignee: 'worker_id' } });
    expect(entryOf(Job)?.relations).to.deep.equal({ assignee: { column: 'worker_id' } });

    class Doc extends ModelBase {
      @Primary() public id: number;
      @Relation('assignee') public assignee_id: string;
    }
    registerAccessResource(Doc, 'doc', { relations: { assignee: 'other_id' } });
    expect(() => entryOf(Doc)).to.throw(AuthzConfigError, /relation 'assignee' is @Relation\(\) 'assignee_id' and registered as 'other_id'/);
  });
});
