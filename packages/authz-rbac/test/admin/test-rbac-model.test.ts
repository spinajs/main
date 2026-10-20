import * as chai from 'chai';
import 'mocha';

import { MemoryAdminAssignmentStore } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';
import { TestRbacModel } from './test-rbac-model.js';

const expect = chai.expect;

const withGrant = (grant: GrantDef): RoleDef[] => [{ name: 'r', extends: [], grants: [grant], assignable: true, source: 'test' }];
const model = (roles: RoleDef[]) => new TestRbacModel({ roles, ladders: [], assignments: new MemoryAdminAssignmentStore() });

describe('TestRbacModel', () => {
  it('refuses grants with on or fields, which it would not evaluate', () => {
    expect(() => model(withGrant({ permission: 'file:read', on: [{ type: 'file' }] }))).to.throw(/on/);
    expect(() => model(withGrant({ permission: 'file:read', fields: { read: ['name'] } }))).to.throw(/fields/);
    expect(() => model(withGrant({ permission: 'file:read', requiresTag: 't' }))).to.not.throw();
  });
});
