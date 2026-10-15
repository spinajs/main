import { AuthzAdminFailure, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, EvaluationContext, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacSubjectResolver } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';
import { readScope, readSubject } from '../../src/admin/common.js';

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const P1: ResourceRef = { type: 'project', id: 'p1' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');
const svc = servicePrincipal('svc');

const role = (name: string, grants: readonly string[]): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: grants.map((permission) => ({ permission })) });
const assignment = (id: string, subject: AssignmentSubject, roleName: string, scope: ResourceRef = GLOBAL): Assignment => ({ id, subject, role: roleName, scope, source: 'test' });

async function model(rows: readonly Assignment[]): Promise<RbacModel> {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'file:read', types: ['project', 'file'] }], 'test');
  registry.freeze();
  const m = new RbacModel({ roles: new MemoryRoleStore([role('viewer', ['file:read'])]), assignments: new MemoryAssignmentStore(rows), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  m.grantIndex();
  return m;
}

const scopes = new FakeScopeResolver({ types: ['project', 'file'], nodes: [{ ref: P1 }, { ref: f1, parent: P1 }] });
const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

describe('authz-rbac wildcard subjects (design §4.2)', () => {
  it('the resolver adds <type>:* for the principal and each companion, after the principals', () => {
    const p = servicePrincipal('svc', { companions: [alice] });
    expect(new RbacSubjectResolver().subjects(p)).to.deep.equal([{ type: 'service', id: 'svc' }, { type: 'user', id: 'alice' }, { type: 'service', id: '*' }, { type: 'user', id: '*' }]);
  });

  it('a principal whose id is * is no subject of its own, only its type wildcard', () => {
    expect(new RbacSubjectResolver().subjects(userPrincipal('*'))).to.deep.equal([{ type: 'user', id: '*' }]);
  });

  it('a role assigned to user:* holds for every user and for no other type', async () => {
    const m = await model([assignment('w1', { type: 'user', id: '*' }, 'viewer', P1)]);
    expect((await m.evaluate({ principal: alice, permission: 'file:read', resource: f1 }, ctx())).permitWhen.op).to.equal('true');
    expect((await m.evaluate({ principal: svc, permission: 'file:read', resource: f1 }, ctx())).permitWhen.op).to.equal('false');
  });

  it('admin input refuses a subject type * and a scope id *', () => {
    expect(readSubject({ type: 'user', id: '*' }, 'subject')).to.deep.equal({ type: 'user', id: '*' });
    for (const [v, field] of [
      [{ type: '*', id: '*' }, 'subject'],
      [{ type: '*', id: 'x' }, 'subject'],
      [{ set: { role: 'member', scope: { type: 'team', id: '*' } } }, 'subject.set.scope'],
    ] as const) {
      let caught: unknown;
      try {
        readSubject(v, 'subject');
      } catch (e) {
        caught = e;
      }
      expect(caught, JSON.stringify(v)).to.be.instanceOf(AuthzAdminFailure);
      expect((caught as AuthzAdminFailure).field).to.equal(field);
    }
    expect(() => readScope({ type: 'invoice', id: '*' }, 'scope')).to.throw(AuthzAdminFailure, "'*' is a wildcard of principal subjects only");
  });
});
