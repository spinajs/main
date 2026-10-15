import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { ModelBase, Primary } from '@spinajs/orm';

import { AccessResource, Owner, Parent, Self, registerAccessResource } from '../src/index.js';
import { classesOf, entryOf, registeredTypes, resetRegistry, typesAbove, unregisterResource } from '../src/registry.js';

const expect = chai.expect;

/** A class with an `id` primary key, as the ORM's @Primary declares it. */
function model(name: string, base: typeof ModelBase = ModelBase): typeof ModelBase {
  const cls = { [name]: class extends base {} }[name] as typeof ModelBase;
  Primary()(cls.prototype, 'id');
  return cls;
}

describe('authz-orm registry', () => {
  afterEach(() => resetRegistry());

  it('reads @AccessResource, @Parent, @Owner and @Self into one frozen entry', () => {
    const Task = model('Task');
    Parent('project')(Task.prototype, 'project_id');
    Parent('sprint', { nullable: true })(Task.prototype, 'sprint_id');
    Owner()(Task.prototype, 'owner_id');
    AccessResource('task')(Task);

    const e = entryOf(Task)!;
    expect(e.type).to.equal('task');
    expect(e.registered).to.equal(Task);
    expect(e.idColumn).to.equal('id');
    expect(e.parents).to.deep.equal([
      { property: 'project_id', column: 'project_id', type: 'project', nullable: false },
      { property: 'sprint_id', column: 'sprint_id', type: 'sprint', nullable: true },
    ]);
    expect(e.owner).to.deep.equal({ property: 'owner_id', column: 'owner_id' });
    expect(e.self).to.equal(undefined);
    expect(Object.isFrozen(e)).to.equal(true);
    expect(Object.isFrozen(e.parents)).to.equal(true);
  });

  it('registerAccessResource declares parents, owner and self by column', () => {
    const User = model('User');
    registerAccessResource(User as never, 'user', { self: 'Uuid', parents: [{ column: 'org_id', type: 'org' }], owner: 'created_by' });
    const e = entryOf(User)!;
    expect(e.self).to.deep.equal({ column: 'Uuid' });
    expect(e.owner).to.deep.equal({ property: 'created_by', column: 'created_by' });
    expect(e.parents).to.deep.equal([{ property: 'org_id', column: 'org_id', type: 'org', nullable: false }]);
  });

  it('an owner may name a principal type column (decorator or registration)', () => {
    const Job = model('JobRow');
    registerAccessResource(Job as never, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } });
    expect(entryOf(Job)!.owner).to.deep.equal({ property: 'InitiatorId', column: 'InitiatorId', typeColumn: 'InitiatorType' });
    const Doc = model('Doc');
    Owner({ typeColumn: 'owner_type' })(Doc.prototype, 'owner_id');
    AccessResource('doc')(Doc);
    expect(entryOf(Doc)!.owner).to.deep.equal({ property: 'owner_id', column: 'owner_id', typeColumn: 'owner_type' });
    expect(() => registerAccessResource(model('Bad') as never, 'bad', { owner: { column: 'a', typeColumn: 'a' } })).to.throw(AuthzConfigError, /typeColumn must differ/);
    const Note = model('Note');
    Owner({ typeColumn: 'owner_type' })(Note.prototype, 'owner_id');
    registerAccessResource(Note as never, 'note', { owner: 'owner_id' });
    expect(() => entryOf(Note)).to.throw(AuthzConfigError, /owner/);
  });

  it('a subclass inherits the entry of its nearest registered ancestor and adds its own parents', () => {
    const Base = model('Folder');
    Parent('project')(Base.prototype, 'project_id');
    AccessResource('folder')(Base);
    const Sub = model('SubFolder', Base);
    Parent('folder', { nullable: true })(Sub.prototype, 'parent_id');
    const e = entryOf(Sub)!;
    expect(e.registered).to.equal(Base);
    expect(e.parents.map((p) => p.column)).to.deep.equal(['project_id', 'parent_id']);
    expect(entryOf(Base)!.parents.map((p) => p.column)).to.deep.equal(['project_id']);
  });

  it('is idempotent for the same registration and refuses a conflicting one', () => {
    const Job = model('Job');
    registerAccessResource(Job as never, 'job', { owner: 'initiator' });
    registerAccessResource(Job as never, 'job', { owner: 'initiator' });
    expect(() => registerAccessResource(Job as never, 'job', { owner: 'other' })).to.throw(AuthzConfigError, /already registered/);
    expect(() => registerAccessResource(Job as never, 'task')).to.throw(AuthzConfigError, /already registered/);
  });

  it('refuses bad declarations with AuthzConfigError', () => {
    const M = model('M');
    expect(() => AccessResource('')(M)).to.throw(AuthzConfigError, /non-empty string/);
    expect(() => AccessResource('$global')(M)).to.throw(AuthzConfigError, /not a resource type/);
    expect(() => Parent('$global')).to.throw(AuthzConfigError, /resource type/);
    const N = model('N');
    Owner()(N.prototype, 'a');
    expect(() => Owner()(N.prototype, 'b')).to.throw(AuthzConfigError, /one owner/);
    Self()(N.prototype, 'Uuid');
    expect(() => Self()(N.prototype, 'other')).to.throw(AuthzConfigError, /one self/);
    Parent('org')(N.prototype, 'org_id');
    expect(() => Parent('team')(N.prototype, 'org_id')).to.throw(AuthzConfigError, /one @Parent per property/);
    const O = model('O');
    Owner()(O.prototype, 'owner');
    expect(() => registerAccessResource(O as never, 'o', { owner: 'someone_else' })).to.throw(AuthzConfigError, /owner/);
    const NoPk = { NoPk: class extends ModelBase {} }.NoPk;
    AccessResource('nopk')(NoPk);
    expect(() => entryOf(NoPk)).to.throw(AuthzConfigError, /primary key/);
  });

  it('lists classes by type in registration order, types, and the types above a type', () => {
    const A = model('A');
    const B = model('B');
    Parent('project')(A.prototype, 'project_id');
    AccessResource('task')(A);
    AccessResource('task')(B);
    const P = model('P');
    Parent('org')(P.prototype, 'org_id');
    AccessResource('project')(P);
    expect(classesOf('task')).to.deep.equal([A, B]);
    expect(registeredTypes()).to.deep.equal(['task', 'project']);
    expect(typesAbove('task')).to.deep.equal(['project', 'org']);
    unregisterResource(B);
    expect(classesOf('task')).to.deep.equal([A]);
  });
});
