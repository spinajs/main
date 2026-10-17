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

  it('a subclass overrides an inherited @Relation column', () => {
    @AccessResource('task')
    class Base extends ModelBase {
      @Primary() public id: number;
      @Relation('assignee') public assignee_id: string;
    }
    class Child extends Base {
      @Primary() public id: number;
      @Relation('assignee') public worker_id: string;
    }
    expect(entryOf(Base)?.relations).to.deep.equal({ assignee: { column: 'assignee_id' } });
    expect(entryOf(Child)?.relations).to.deep.equal({ assignee: { column: 'worker_id' } });
  });

  it('refuses two different columns for one relation name on one class', () => {
    expect(() => {
      class Task extends ModelBase {
        @Relation('assignee') public a: string;
        @Relation('assignee') public b: string;
      }
      void Task;
    }).to.throw(AuthzConfigError, /@Relation\('assignee'\) is on .* already/);
  });

  it('refuses re-registration with changed relations', () => {
    class Job extends ModelBase {
      @Primary() public id: number;
    }
    registerAccessResource(Job, 'job', { relations: { assignee: 'a' } });
    registerAccessResource(Job, 'job', { relations: { assignee: 'a' } });
    expect(() => registerAccessResource(Job, 'job', { relations: { assignee: 'b' } })).to.throw(AuthzConfigError, /already registered .* with other options/);
  });

  it('refuses malformed relations and keeps the owner messages', () => {
    class Job extends ModelBase {
      @Primary() public id: number;
    }
    expect(() => registerAccessResource(Job, 'job', { relations: [] as never })).to.throw(AuthzConfigError, /relations must map a name/);
    expect(() => registerAccessResource(Job, 'job', { relations: { owner: 'a' } })).to.throw(AuthzConfigError, /@Owner\(\)/);
    expect(() => registerAccessResource(Job, 'job', { relations: { '9x': 'a' } })).to.throw(AuthzConfigError, /relation name/);
    expect(() => registerAccessResource(Job, 'job', { owner: { column: 'a', typeColumn: 'a' } })).to.throw(AuthzConfigError, /typeColumn must differ from the owner column/);
  });
});
