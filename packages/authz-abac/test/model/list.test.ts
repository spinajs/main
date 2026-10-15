import * as chai from 'chai';
import 'mocha';
import { PermissionRegistryImpl } from '@spinajs/authz';
import type { Policy } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';

import { AbacModel, MemoryPolicyStore } from '../../src/index.js';

const expect = chai.expect;

const registry = (): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'doc:read', types: ['doc'], list: true },
      { name: 'doc:write', types: ['doc'] },
      { name: 'doc:delete', types: ['doc'], list: true },
    ],
    'test',
  );
  r.freeze();
  return r;
};

const policy = (id: string, extra: Partial<Policy> = {}): Policy => ({ id, effect: 'permit', permissions: ['doc:read'], source: 'test', ...extra });

async function modelWith(policies: readonly Policy[]): Promise<{ model: AbacModel; registry: PermissionRegistryImpl }> {
  const reg = registry();
  const model = new AbacModel({ stores: [new MemoryPolicyStore(policies)] });
  await model.init(fakeModelInitContext({ permissions: reg }));
  return { model, registry: reg };
}

const support = async (policies: readonly Policy[], permission = 'doc:read', type = 'doc') => {
  const { model, registry: reg } = await modelWith(policies);
  return model.listSupport(reg.require(permission), type);
};

describe('authz-abac: list support', () => {
  it('is true for policies that read the principal, the actor and env only', async () => {
    expect(await support([policy('p1'), policy('p2', { when: { attr: 'principal.attributes.dept', eq: 'ops' } }), policy('d1', { effect: 'deny', when: { attr: 'env.ip', eq: '10.0.0.1' } }), policy('a1', { actorTypes: ['agent'], when: { attr: 'actor.type', eq: 'agent' } }), policy('g1', { when: { attr: 'scope.$global.flags.open', eq: true } }), policy('s1', { scope: { type: '$global' } })])).to.equal(true);
  });

  it('refuses a permit or a deny that reads resource.*', async () => {
    expect(await support([policy('own', { when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } })])).to.deep.equal({ reason: 'abac policy "own" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable' });
    expect(await support([policy('closed', { effect: 'deny', when: { attr: 'resource.status', eq: 'closed' } })])).to.deep.equal({ reason: 'abac policy "closed" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable' });
  });

  it('refuses a function whose args read resource.*', async () => {
    const out = await support([policy('named', { when: { fn: 'glob', args: { value: { ref: 'resource.name' }, pattern: 'a/*' } } })]);
    expect(out).to.deep.equal({ reason: 'abac policy "named" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable' });
  });

  it('refuses scope attributes of a node and a scoped policy', async () => {
    expect(await support([policy('frozen', { effect: 'deny', when: { attr: 'scope.org.policies.frozen', eq: true } })])).to.deep.equal({ reason: 'abac policy "frozen" (source: test) reads scope.org.* in its condition, so doc:read on "doc" is not list-filterable' });
    expect(await support([policy('org', { scope: { type: 'org', id: 'o1' } })])).to.deep.equal({ reason: 'abac policy "org" (source: test) applies under org:o1 only, so doc:read on "doc" is not list-filterable' });
  });

  it('ignores policies that cannot match the permission or the type', async () => {
    expect(await support([policy('w', { permissions: ['doc:write'], when: { attr: 'resource.x', eq: 1 } }), policy('t', { resourceTypes: ['folder'], when: { attr: 'resource.x', eq: 1 } })])).to.equal(true);
  });

  it('listProblem names the list permission a new policy would break, or nothing', async () => {
    const { model } = await modelWith([]);
    expect(model.listProblem({ id: 'n', effect: 'deny', permissions: ['doc:*'], when: { attr: 'resource.status', eq: 'x' } })).to.equal('abac policy "n" (source: db) reads resource.* in its condition, so doc:delete on "doc" is not list-filterable');
    expect(model.listProblem({ id: 'w', effect: 'permit', permissions: ['doc:write'], when: { attr: 'resource.status', eq: 'x' } })).to.equal(undefined);
    expect(model.listProblem({ id: 'ok', effect: 'permit', permissions: ['doc:read'], when: { attr: 'principal.attributes.dept', eq: 'ops' } })).to.equal(undefined);
  });
});
