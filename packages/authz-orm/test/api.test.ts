import * as chai from 'chai';
import 'mocha';

import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import * as root from '../src/index.js';
import * as stubs from '../src/api.js';

const expect = chai.expect;

const model = class Fake {} as unknown as Class<ModelBase>;
const notImplemented = (name: string) => new RegExp(`^@spinajs/authz-orm: ${name} is not implemented yet$`);

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Same<A, B>) => ok;

describe('authz-orm api', () => {
  // api.ts is frozen and keeps its stubs; src/index.ts exports the implementations in their place.
  it('every stub of api.ts throws not implemented', async () => {
    expect(() => stubs.AccessResource('task')).to.throw(Error, notImplemented('AccessResource'));
    expect(() => stubs.Parent('project', { nullable: true })).to.throw(Error, notImplemented('Parent'));
    expect(() => stubs.Owner()).to.throw(Error, notImplemented('Owner'));
    expect(() => stubs.Owner({ typeColumn: 'InitiatorType' })).to.throw(Error, notImplemented('Owner'));
    expect(() => stubs.registerAccessResource(model, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } })).to.throw(Error, notImplemented('registerAccessResource'));
    expect(() => stubs.Self()).to.throw(Error, notImplemented('Self'));
    expect(() => stubs.registerAccessResource(model, 'job', { owner: 'initiator', self: 'Uuid', parents: [{ column: 'org_id', type: 'org' }] })).to.throw(Error, notImplemented('registerAccessResource'));
    expect(() => stubs.reparent(model, ['1'], '2', 'project_id')).to.throw(Error, notImplemented('reparent'));
  });

  it('the root exports implementations with the frozen types', () => {
    same<typeof root.AccessResource, typeof stubs.AccessResource>(true);
    same<typeof root.Parent, typeof stubs.Parent>(true);
    same<typeof root.Owner, typeof stubs.Owner>(true);
    same<typeof root.Self, typeof stubs.Self>(true);
    same<typeof root.registerAccessResource, typeof stubs.registerAccessResource>(true);
    same<typeof root.reparent, typeof stubs.reparent>(true);
    for (const k of ['AccessResource', 'Parent', 'Owner', 'Self', 'registerAccessResource', 'reparent']) {
      expect((root as Record<string, unknown>)[k], k).to.not.equal((stubs as Record<string, unknown>)[k]);
    }
    const t: ResourceType = 'task';
    expect(() => root.AccessResource(t)).to.not.throw();
  });

  it('keeps the scope attribute store and the config schema on the root', () => {
    expect(root.DbScopeAttributeStore).to.be.a('function');
    expect(root.AUTHZ_ORM_CONFIGURATION_SCHEMA.properties).to.have.keys(['domain']);
  });
});
