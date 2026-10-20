import { Authorizer, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, DecisionRequest, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, ManualClock, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '../../src/index.js';
import type { LadderDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-17T12:00:00.000Z');
const VIEWER: RoleDef = { name: 'viewer', extends: [], assignable: true, source: 'test', grants: [{ permission: 'doc:read' }] };
const assignment = (id: string): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: 'viewer', scope: GLOBAL, source: 'test' });
// Type-level, so no ancestors are read.
const req = (fresh?: boolean): DecisionRequest => ({ principal: userPrincipal('alice'), permission: 'doc:read', resource: { type: 'doc' }, ...(fresh ? { fresh } : {}) });

async function setup(rows: readonly Assignment[]) {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'doc:read', types: ['doc'], list: true }], 'test');
  registry.freeze();
  const store = new MemoryAssignmentStore(rows);
  const model = new RbacModel({ roles: new MemoryRoleStore([VIEWER]), assignments: store, clock: new ManualClock(NOW), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  return { model, store, registry };
}

describe('authz-rbac model: fresh requests', () => {
  it('a fresh request does not honour an assignment the cache still holds', async () => {
    const { model, store } = await setup([assignment('v1')]);
    expect((await model.evaluate(req(), fakeEvaluationContext({ now: NOW }))).permitWhen).to.deep.equal(TRUE);
    store.remove('v1');
    expect((await model.evaluate(req(), fakeEvaluationContext({ now: NOW }))).permitWhen).to.deep.equal(TRUE);
    expect((await model.evaluate(req(true), fakeEvaluationContext({ now: NOW }))).permitWhen).to.deep.equal(FALSE);
    expect((await model.evaluate(req(), fakeEvaluationContext({ now: NOW }))).permitWhen).to.deep.equal(FALSE);
  });

  it('a fresh list plan does not honour an assignment the cache still holds', async () => {
    const { model, store, registry } = await setup([assignment('v1')]);
    model.grantIndex();
    const plan = (fresh?: boolean) => model.listPlan({ principal: userPrincipal('alice'), permission: registry.require('doc:read'), type: 'doc', env: { now: NOW }, ...(fresh ? { fresh } : {}) }, fakeEvaluationContext({ now: NOW }));
    const held = await plan();
    expect(held.kind).to.equal('all');
    store.remove('v1');
    expect(await plan()).to.deep.equal(held);
    expect(await plan(true)).to.deep.equal({ kind: 'abstain' });
  });

  it('an access plan of a consistency fresh permission does not honour an assignment the cache still holds', async () => {
    const registry = new PermissionRegistryImpl();
    registry.register([{ name: 'doc:read', types: ['doc'], list: true }, { name: 'doc:audit', types: ['doc'], list: true, consistency: 'fresh' }], 'test');
    registry.freeze();
    const store = new MemoryAssignmentStore([assignment('v1')]);
    const role: RoleDef = { ...VIEWER, grants: [{ permission: 'doc:read' }, { permission: 'doc:audit' }] };
    const model = new RbacModel({ roles: new MemoryRoleStore([role]), assignments: store, clock: new ManualClock(NOW), log: { warn: () => undefined } });
    await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
    model.grantIndex();
    const authz = new Authorizer({ domain: 'root', models: [model], registry, log: { error: () => undefined, warn: () => undefined, debug: () => undefined } });
    const all = { kind: 'filter', permit: 'all', deny: [] };
    expect(await authz.accessPlan(userPrincipal('alice'), 'doc:read', 'doc')).to.deep.equal(all);
    expect(await authz.accessPlan(userPrincipal('alice'), 'doc:audit', 'doc')).to.deep.equal(all);
    store.remove('v1');
    expect(await authz.accessPlan(userPrincipal('alice'), 'doc:read', 'doc')).to.deep.equal(all);
    expect((await authz.accessPlan(userPrincipal('alice'), 'doc:audit', 'doc')).kind).to.equal('none');
  });

  it('a fresh request needs IO even when the cache is warm, so the sync path cannot serve it', async () => {
    const { model } = await setup([assignment('v1')]);
    await model.evaluate(req(), fakeEvaluationContext({ now: NOW }));
    expect(model.evaluate(req(), fakeEvaluationContext({ now: NOW }))).to.not.be.instanceOf(Promise);
    expect(model.evaluate(req(true), fakeEvaluationContext({ now: NOW }))).to.be.instanceOf(Promise);
  });

  describe('through subject sets', () => {
    const O1: ResourceRef = { type: 'org', id: 'o1' };
    const P1: ResourceRef = { type: 'project', id: 'p1' };
    const role = (name: string, grants: readonly string[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });
    const ladders: LadderDef[] = [{ name: 'org', roles: ['org.member'] }];
    const roles = [role('org.member', [], { ladder: 'org', subjectSet: true }), role('viewer', ['doc:read'])];
    const set: AssignmentSubject = { set: { role: 'org.member', scope: O1 } };
    const rows: Assignment[] = [
      { id: 'm1', subject: { type: 'user', id: 'alice' }, role: 'org.member', scope: O1, source: 'test' },
      { id: 's1', subject: set, role: 'viewer', scope: P1, source: 'test' },
    ];
    const scopes = new FakeScopeResolver({ types: ['org', 'project'], nodes: [{ ref: O1 }, { ref: P1, parent: O1 }] });
    const setReq = (fresh?: boolean): DecisionRequest => ({ principal: userPrincipal('alice'), permission: 'doc:read', resource: P1, ...(fresh ? { fresh } : {}) });
    const ctx = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

    async function setSetup() {
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'doc:read', types: ['org', 'project'] }], 'test');
      registry.freeze();
      const store = new MemoryAssignmentStore(rows);
      const model = new RbacModel({ roles: new MemoryRoleStore(roles, ladders), assignments: store, clock: new ManualClock(NOW), log: { warn: () => undefined } });
      await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
      return { model, store };
    }

    for (const gone of ['m1', 's1']) {
      it(`a fresh request does not honour the removed ${gone === 'm1' ? 'membership' : 'set grant'} the cache still holds`, async () => {
        const { model, store } = await setSetup();
        expect((await model.evaluate(setReq(), ctx())).permitWhen).to.deep.equal(TRUE);
        store.remove(gone);
        expect((await model.evaluate(setReq(), ctx())).permitWhen).to.deep.equal(TRUE);
        expect((await model.evaluate(setReq(true), ctx())).permitWhen).to.deep.equal(FALSE);
      });
    }
  });
});
