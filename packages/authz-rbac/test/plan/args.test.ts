import * as chai from 'chai';
import 'mocha';

import { parsePrincipalSubjectKey, parseRbacPlanArgs, rbacPlanArgs } from '../../src/index.js';
import type { RbacAssignmentPlanArgs } from '../../src/index.js';

const expect = chai.expect;

const args = (over: Partial<RbacAssignmentPlanArgs> = {}): RbacAssignmentPlanArgs => rbacPlanArgs({ subjects: ['user:alice'], roles: [{ role: 'editor' }], global: false, ...over });

describe('rbac.assignment args', () => {
  it('canonical: sorted, deduplicated, frozen', () => {
    const a = rbacPlanArgs({ subjects: ['user:b', 'user:a', 'user:b'], roles: [{ role: 'z' }, { role: 'a', scopeTypes: ['project', 'org'] }, { role: 'z' }], global: false });
    expect(a).to.deep.equal({ subjects: ['user:a', 'user:b'], roles: [{ role: 'a', scopeTypes: ['org', 'project'] }, { role: 'z' }], global: false });
    expect(Object.isFrozen(a.roles)).to.equal(true);
  });

  it('parse refuses unknown keys and wrong types', () => {
    expect(() => parseRbacPlanArgs({ ...args(), extra: 1 })).to.throw('rbac.assignment: unknown args key(s) extra');
    expect(() => parseRbacPlanArgs({ ...args(), roles: [{ role: 'x', when: 1 }] })).to.throw('rbac.assignment: roles[0] has unknown key(s) when');
    expect(() => parseRbacPlanArgs({ ...args(), global: 'yes' })).to.throw('rbac.assignment: global must be a boolean');
    expect(() => parseRbacPlanArgs({ ...args(), membership: false, memberKeys: [] })).to.throw('rbac.assignment: unknown args key(s) membership, memberKeys');
    expect(parseRbacPlanArgs(JSON.parse(JSON.stringify(args())))).to.deep.equal(args());
  });

  it('a principal subject key names one principal; wildcards and sets name none', () => {
    expect(parsePrincipalSubjectKey('user:%2A')).to.deep.equal({ type: 'user', id: '*' });
    expect(parsePrincipalSubjectKey('user:*')).to.equal(undefined);
    expect(parsePrincipalSubjectKey('team:t1#member')).to.equal(undefined);
  });
});
