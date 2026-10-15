import { AuthzAdminFailure, AuthzConfigError, GLOBAL, ListSupportGuard, PermissionRegistryImpl } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzService } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacRuleListGuard } from '../../src/index.js';

const expect = chai.expect;

async function context(): Promise<AdminContext> {
  const registry = new PermissionRegistryImpl();
  registry.register(
    [
      { name: 'doc:read', types: ['doc'], list: true },
      { name: 'doc:write', types: ['doc'] },
      { name: 'job:read', types: ['job'], list: true },
    ],
    'test',
  );
  registry.freeze();
  const model = new RbacModel({ roles: new MemoryRoleStore([]), assignments: new MemoryAssignmentStore(), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  return { domain: 'root', now: new Date('2026-10-14T12:00:00.000Z'), authz: { models: () => [model] } as unknown as AuthzService };
}

const put = (rule: Record<string, unknown>): AuthzCommand => ({ kind: 'rule.put', rule: { scope: GLOBAL, ...rule } as never });

async function refusal(p: Promise<unknown>): Promise<AuthzAdminFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzAdminFailure);
    return e as AuthzAdminFailure;
  }
  throw new Error('expected a refusal');
}

describe('authz-rbac RbacRuleListGuard (design §7)', () => {
  it('is registered as a ListSupportGuard', async () => {
    expect(((await DI.resolve(Array.ofType(ListSupportGuard))) as ListSupportGuard[]).some((g) => g instanceof RbacRuleListGuard)).to.equal(true);
  });

  it('refuses a cap or restrict on a type with a list permission', async () => {
    const e = await refusal(new RbacRuleListGuard().checkCommand(put({ id: 'strip', kind: 'cap', stripTags: true }), await context()));
    expect(e).to.deep.include({ code: 'not_list_filterable', field: 'rule' });
    expect(e.message).to.equal('rbac rule \'strip\' (cap) can apply to doc:read on "doc", which is list: true; lists cannot follow rules');
  });

  it('accepts a rule that cannot reach a list permission', async () => {
    const guard = new RbacRuleListGuard();
    await guard.checkCommand(put({ id: 't', kind: 'threshold', permissions: ['doc:write'], minRole: 'x' }), await context());
    await guard.checkCommand(put({ id: 'r', kind: 'restrict', resourceTypes: ['folder'], allow: [] }), await context());
    await guard.checkCommand({ kind: 'policy.put', policy: { id: 'p', effect: 'permit', permissions: ['doc:read'] } }, await context());
  });

  it('a domain without a permission registry is a configuration error', async () => {
    const ctx = { ...(await context()), authz: { models: () => [] } as unknown as AuthzService };
    let caught: unknown;
    try {
      await new RbacRuleListGuard().checkCommand(put({ id: 'strip', kind: 'cap', stripTags: true }), ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(caught).to.not.be.instanceOf(AuthzAdminFailure);
    expect(caught === undefined || caught instanceof AuthzConfigError || /registry|container/i.test((caught as Error).message)).to.equal(true);
  });
});
