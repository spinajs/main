import * as chai from 'chai';
import 'mocha';

import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import * as root from '../src/index.js';
import * as api from '../src/api.js';
import type { AccessResourceOptions, OwnerOptions, ParentOptions, RelationOptions } from '../src/index.js';

const expect = chai.expect;

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Same<A, B>) => ok;

describe('authz-orm api', () => {
  it('api.ts holds only contracts; the root exports the implementations', () => {
    for (const k of ['AccessResource', 'Parent', 'Owner', 'Self', 'Relation', 'registerAccessResource', 'reparent']) {
      expect((root as Record<string, unknown>)[k], k).to.be.a('function');
      expect(api, k).to.not.have.property(k);
    }
    const t: ResourceType = 'task';
    expect(() => root.AccessResource(t)).to.not.throw();
  });

  it('the implementations keep the frozen signatures', () => {
    same<typeof root.AccessResource, (type: ResourceType) => ClassDecorator>(true);
    same<typeof root.Parent, (type: ResourceType, opts?: ParentOptions) => PropertyDecorator>(true);
    same<typeof root.Owner, (opts?: OwnerOptions) => PropertyDecorator>(true);
    same<typeof root.Self, () => PropertyDecorator>(true);
    same<typeof root.Relation, (name: string, opts?: RelationOptions) => PropertyDecorator>(true);
    same<typeof root.registerAccessResource, (model: Class<ModelBase>, type: ResourceType, opts?: AccessResourceOptions) => void>(true);
    same<typeof root.reparent, (model: Class<ModelBase>, ids: readonly (string | number)[], newParentId: string | number | null, column?: string) => Promise<number>>(true);
  });

  it('keeps the scope attribute store and the config schema on the root', () => {
    expect(root.DbScopeAttributeStore).to.be.a('function');
    expect(root.AUTHZ_ORM_CONFIGURATION_SCHEMA.properties).to.have.keys(['domain', 'accessField']);
  });
});
