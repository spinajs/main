import { FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, DecisionRequest } from '@spinajs/authz';
import { ManualClock, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-17T12:00:00.000Z');
const VIEWER: RoleDef = { name: 'viewer', extends: [], assignable: true, source: 'test', grants: [{ permission: 'doc:read' }] };
const assignment = (id: string): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: 'viewer', scope: GLOBAL, source: 'test' });
// Type-level, so no ancestors are read.
const req = (fresh?: boolean): DecisionRequest => ({ principal: userPrincipal('alice'), permission: 'doc:read', resource: { type: 'doc' }, ...(fresh ? { fresh } : {}) });

async function setup(rows: readonly Assignment[]) {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'doc:read', types: ['doc'] }], 'test');
  registry.freeze();
  const store = new MemoryAssignmentStore(rows);
  const model = new RbacModel({ roles: new MemoryRoleStore([VIEWER]), assignments: store, clock: new ManualClock(NOW), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  return { model, store };
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
});
