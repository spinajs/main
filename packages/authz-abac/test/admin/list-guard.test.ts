import * as chai from 'chai';
import 'mocha';
import { AuthzAdminFailure, ListSupportGuard, PermissionRegistryImpl } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzService } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import { AbacListSupportGuard, AbacModel, MemoryPolicyStore } from '../../src/index.js';

const expect = chai.expect;

async function context(): Promise<AdminContext> {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'doc:read', types: ['doc'], list: true }, { name: 'doc:write', types: ['doc'] }], 'test');
  registry.freeze();
  const model = new AbacModel({ stores: [new MemoryPolicyStore([])] });
  await model.init(fakeModelInitContext({ permissions: registry }));
  return { domain: 'root', now: new Date('2026-10-14T12:00:00.000Z'), authz: { models: () => [model] } as unknown as AuthzService };
}

const put = (policy: Record<string, unknown>): AuthzCommand => ({ kind: 'policy.put', policy: { effect: 'permit', permissions: ['doc:read'], ...policy } as never });

async function refusal(p: Promise<unknown>): Promise<AuthzAdminFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzAdminFailure);
    return e as AuthzAdminFailure;
  }
  throw new Error('expected a refusal');
}

describe('authz-abac: AbacListSupportGuard', () => {
  it('is registered as a ListSupportGuard at import', async () => {
    const guards = (await DI.resolve(Array.ofType(ListSupportGuard))) as ListSupportGuard[];
    expect(guards.some((g) => g instanceof AbacListSupportGuard)).to.equal(true);
  });

  it('refuses a policy that reads the row on a list permission', async () => {
    const e = await refusal(new AbacListSupportGuard().checkCommand(put({ id: 'own', when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } }), await context()));
    expect(e.code).to.equal('not_list_filterable');
    expect(e.field).to.equal('policy');
    expect(e.message).to.equal('abac policy "own" (source: db) reads resource.* in its condition, so doc:read on "doc" is not list-filterable');
  });

  it('accepts a row-dependent policy on a permission without list, and any principal-level policy', async () => {
    const guard = new AbacListSupportGuard();
    await guard.checkCommand(put({ id: 'w', permissions: ['doc:write'], when: { attr: 'resource.status', eq: 'x' } }), await context());
    await guard.checkCommand(put({ id: 'p', when: { attr: 'principal.attributes.dept', eq: 'ops' } }), await context());
    await guard.checkCommand({ kind: 'rule.put', rule: { id: 'r', kind: 'cap', scope: { type: '$global' } } } as AuthzCommand, await context());
  });
});
