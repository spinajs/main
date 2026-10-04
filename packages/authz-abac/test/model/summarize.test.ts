import * as chai from 'chai';
import 'mocha';
import { Authorizer, DefaultConditionCompiler, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Policy, Principal } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';

import { AbacModel, ConfigPolicyStore } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = { type: 'org', id: 'o1' };
const F1 = { type: 'file', id: 'f1' };

const registry = (): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'doc:read', types: ['doc', 'file'], fields: true },
      { name: 'doc:write', types: ['doc', 'file'] },
      { name: 'doc:delete', types: ['doc', 'file'] },
    ],
    'test',
  );
  r.freeze();
  return r;
};

const policy = (id: string, extra: Partial<Policy> = {}): Policy => ({ id, effect: 'permit', permissions: ['doc:read'], source: 'test', ...extra });

async function model(policies: readonly Policy[], reg = registry()): Promise<AbacModel> {
  const m = new AbacModel({ stores: [new ConfigPolicyStore(policies)] });
  await m.init(fakeModelInitContext({ permissions: reg }));
  return m;
}

const resolver = () => new FakeScopeResolver({ nodes: [{ ref: F1, parent: O1 }] });
const ctx = (reg = registry()) => fakeEvaluationContext({ now: NOW, permissions: reg, scopeResolvers: [resolver()], conditions: new DefaultConditionCompiler() });

const alice = userPrincipal('alice', { attributes: { team: 'x', level: 'high' } });
const bob = userPrincipal('bob', { attributes: { team: 'y' } });
const svc = servicePrincipal('svc');

describe('authz-abac: summarize (H18)', () => {
  it("lists the permit policies' permissions for the principal at GLOBAL, conditions bound for it", async () => {
    const m = await model([policy('read'), policy('team-x', { permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'x' } }), policy('own', { permissions: ['doc:delete'], when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } }), policy('deny', { effect: 'deny', permissions: ['doc:*'] }), policy('services', { permissions: ['doc:write'], principalTypes: ['service'] })]);
    expect(await m.summarize(alice, GLOBAL, ctx())).to.deep.equal({
      model: 'abac',
      permissions: [
        { name: 'doc:delete', conditional: true },
        { name: 'doc:read', conditional: false, fields: { read: ['*'], write: ['*'] } },
        { name: 'doc:write', conditional: false },
      ],
    });
    expect((await m.summarize(bob, GLOBAL, ctx())).permissions.map((p) => p.name)).to.deep.equal(['doc:delete', 'doc:read']);
    expect((await m.summarize(svc, GLOBAL, ctx())).permissions.map((p) => p.name)).to.deep.equal(['doc:delete', 'doc:read', 'doc:write']);
  });

  it('an unconditional policy wins over a conditional one for the same permission; fields go with it', async () => {
    const m = await model([policy('cond', { when: { attr: 'resource.status', eq: 'open' } }), policy('all', { fields: { read: ['name'] } })]);
    expect((await m.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'doc:read', conditional: false, fields: { read: ['name'], write: [] } }]);
  });

  it('decides scopes on the path of `at`; a scoped policy is not listed at GLOBAL', async () => {
    const m = await model([policy('o1', { scope: O1 })]);
    expect((await m.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([]);
    expect((await m.summarize(alice, F1, ctx())).permissions).to.deep.equal([{ name: 'doc:read', conditional: false, fields: { read: ['*'], write: ['*'] } }]);
  });

  it('drops expired policies and those a principal condition rules out', async () => {
    const m = await model([policy('old', { expiresAt: new Date(NOW.getTime() - 1) }), policy('low', { permissions: ['doc:write'], when: { attr: 'principal.attributes.level', eq: 'low' } })]);
    expect((await m.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([]);
  });

  describe('through the engine (B26: covers counts ABAC policies)', () => {
    const engine = async (policies: readonly Policy[]) => {
      const reg = registry();
      return new Authorizer({ domain: 'root', models: [await model(policies, reg)], registry: reg, scopeResolvers: [resolver()], conditions: new DefaultConditionCompiler(), clock: () => NOW });
    };
    const covers = (a: Authorizer, holder: Principal, target: Principal) => a.covers(holder, target);

    it('summary lists what the policies give after the checks', async () => {
      const a = await engine([policy('read'), policy('team-x', { permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'x' } }), policy('no-write-y', { effect: 'deny', permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'y' } })]);
      const s = await a.summary(alice);
      expect(s.permissions.map((p) => [p.name, p.conditional])).to.deep.equal([
        ['doc:read', false],
        ['doc:write', false],
      ]);
      expect(s.models.map((m) => m.model)).to.deep.equal(['abac']);
      expect((await a.summary(bob)).permissions.map((p) => p.name)).to.deep.equal(['doc:read']);
    });

    it('a deny policy on the holder takes a permission out of its set, one on the target does not (RFC E1-1); a permit adds to the target', async () => {
      const deny = await engine([policy('all', { permissions: ['doc:*'] }), policy('y-no-delete', { effect: 'deny', permissions: ['doc:delete'], when: { attr: 'principal.attributes.team', eq: 'y' } })]);
      expect(await covers(deny, bob, alice)).to.equal(false);
      // bob's summary lists doc:delete from 'all', and a target's deny never clears a summary entry.
      expect(await covers(deny, alice, bob)).to.equal(false);
      const xDeletes = await engine([policy('all', { permissions: ['doc:read', 'doc:write'] }), policy('x-deletes', { permissions: ['doc:delete'], when: { attr: 'principal.attributes.team', eq: 'x' } })]);
      expect(await covers(xDeletes, alice, bob)).to.equal(true);
      const permit = await engine([policy('read'), policy('team-x', { permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'x' } })]);
      expect(await covers(permit, bob, alice)).to.equal(false);
      expect(await covers(permit, alice, bob)).to.equal(true);
    });
  });
});
