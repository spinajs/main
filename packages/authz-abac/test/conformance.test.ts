import * as chai from 'chai';
import 'mocha';
import { Authorizer, CORE_FILTER_OPS, DefaultConditionCompiler, SCOPE_CONDITION_OP, validateBoot } from '@spinajs/authz';
import type { FilterOp, Policy } from '@spinajs/authz';
import { FakeAdapter, FakeScopeResolver, agentPrincipal, evaluateFilter, fakeEvaluationContext, fakeModelInitContext, runModelConformance, servicePrincipal, userPrincipal, worldRows } from '@spinajs/authz-testing';
import type { ModelFactory, ModelSetup } from '@spinajs/authz-testing';

import { AbacModel, MemoryPolicyStore } from '../src/index.js';

const O1 = { type: 'org', id: 'o1' };
const O2 = { type: 'org', id: 'o2' };

const alice = userPrincipal('alice', { attributes: { team: 'red', level: 3 } });
const bob = userPrincipal('bob', { attributes: { team: 'blue' } });
const svc = servicePrincipal('svc', { companions: [bob] });
const agent = agentPrincipal('ag1', alice, { attributes: { team: 'red' } });

const POLICIES: readonly Policy[] = [
  { id: 'readers', effect: 'permit', permissions: ['file:read'], source: 'test' },
  { id: 'own-writes', effect: 'permit', permissions: ['file:write'], when: { attr: 'resource.owner', eq: { ref: 'principal.id' } }, source: 'test' },
  { id: 'team-writes', effect: 'permit', permissions: ['file:write'], principalTypes: ['user'], when: { attr: 'resource.team', eq: { ref: 'principal.attributes.team' } }, source: 'test' },
  { id: 'closed', effect: 'deny', permissions: ['file:*'], when: { attr: 'resource.status', eq: 'closed' }, reason: 'closed', source: 'test' },
  { id: 'o2-only-red', effect: 'deny', permissions: ['file:read'], scope: O2, when: { not: { attr: 'principal.attributes.team', eq: 'red' } }, reason: 'team', priority: 300, source: 'test' },
  { id: 'agents-no-delete', effect: 'deny', permissions: ['file:delete'], actorTypes: ['agent'], reason: 'agents_disabled', priority: 100, source: 'test' },
  { id: 'deleters', effect: 'permit', permissions: ['file:delete'], when: { attr: 'principal.attributes.level', gte: 3 }, fields: { read: ['name'] }, source: 'test' },
];

const factory: ModelFactory = ({ shuffle }): ModelSetup => {
  const store = new MemoryPolicyStore(shuffle(POLICIES));
  const adapter = new FakeAdapter({
    types: ['file'],
    rows: {
      file: [
        { id: 'a', owner: 'alice', team: 'red', status: 'open' },
        { id: 'b', owner: 'bob', team: 'blue', status: 'closed' },
        { id: 'c', owner: 'carol', team: 'red', status: 'open' },
        { id: 'd', owner: 'bob', team: null, status: 'open' },
      ],
    },
    parents: [
      [{ type: 'file', id: 'a' }, O1],
      [{ type: 'file', id: 'b' }, O1],
      [{ type: 'file', id: 'c' }, O2],
      [{ type: 'file', id: 'd' }, O2],
    ],
  });
  const resolver = new FakeScopeResolver({ nodes: [{ ref: O1 }, { ref: O2 }] });
  const permissions = ['file:read', 'file:write', 'file:delete'].map((name) => ({ name, types: ['file'] }));
  return {
    model: new AbacModel({ stores: [store] }),
    world: {
      principals: [alice, bob, svc],
      actors: [[alice, agent]],
      permissions: ['file:read', 'file:write', 'file:delete'],
      rows: worldRows(adapter),
      context: { adapters: [adapter], scopeResolvers: [resolver], permissions, conditions: new DefaultConditionCompiler(undefined, [resolver], [adapter]) },
    },
    mutations: [
      {
        title: 'a deny policy put in the store',
        request: { principal: alice, permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: { id: 'a', owner: 'alice', team: 'red', status: 'open' } },
        after: false,
        apply: () => store.put({ id: 'freeze', effect: 'deny', permissions: ['file:read'], source: 'test' }),
        tags: ['policy:freeze'],
        freshness: 'invalidate',
      },
    ],
  };
};

// With authz.abac.scopeResiduals on: a, b under orgs holding the attributes, c under an org without
// them, d under an unknown node, e under no org. Checks of c, d and e fault (indeterminate).
const O3 = { type: 'org', id: 'o3' };
const SCOPE_POLICIES: readonly Policy[] = [
  { id: 'readers', effect: 'permit', permissions: ['file:read'], source: 'test' },
  { id: 'open-writes', effect: 'permit', permissions: ['file:write'], when: { attr: 'scope.org.policies.open', eq: true }, source: 'test' },
  { id: 'frozen', effect: 'deny', permissions: ['file:*'], when: { attr: 'scope.org.policies.frozen', eq: true }, reason: 'frozen', source: 'test' },
  { id: 'agents-disabled', effect: 'deny', permissions: ['file:read'], actorTypes: ['agent'], when: { attr: 'scope.org.policies.agents_allowed', eq: false }, reason: 'agents_disabled', priority: 100, source: 'test' },
];
const SCOPE_PERMISSIONS = ['file:read', 'file:write', 'file:delete'].map((name) => ({ name, types: ['file'] }));

function scopeWorld(compiles: readonly FilterOp[] = CORE_FILTER_OPS): { adapter: FakeAdapter; resolver: FakeScopeResolver } {
  const adapter = new FakeAdapter({
    types: ['file'],
    compiles,
    rows: { file: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })) },
    parents: [
      [{ type: 'file', id: 'a' }, O1],
      [{ type: 'file', id: 'b' }, O2],
      [{ type: 'file', id: 'c' }, O3],
      [
        { type: 'file', id: 'd' },
        { type: 'org', id: 'o4' },
      ],
    ],
  });
  const resolver = new FakeScopeResolver({
    nodes: [
      { ref: O1, attributes: { policies: { open: true, frozen: false, agents_allowed: true } } },
      { ref: O2, attributes: { policies: { open: false, frozen: false, agents_allowed: false } } },
      { ref: O3, attributes: {} },
    ],
  });
  return { adapter, resolver };
}

const scopeFactory: ModelFactory = ({ shuffle }): ModelSetup => {
  const store = new MemoryPolicyStore(shuffle(SCOPE_POLICIES));
  const { adapter, resolver } = scopeWorld();
  return {
    model: new AbacModel({ stores: [store] }),
    world: {
      principals: [alice, bob],
      actors: [[alice, agent]],
      permissions: ['file:read', 'file:write'],
      rows: worldRows(adapter),
      config: { scopeResiduals: true },
      context: { adapters: [adapter], scopeResolvers: [resolver], permissions: SCOPE_PERMISSIONS, conditions: new DefaultConditionCompiler(undefined, [resolver], [adapter]) },
    },
    mutations: [
      {
        title: 'a deny policy put in the store',
        request: { principal: alice, permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: { id: 'a' } },
        after: false,
        apply: () => store.put({ id: 'freeze', effect: 'deny', permissions: ['file:read'], source: 'test' }),
        tags: ['policy:freeze'],
        freshness: 'invalidate',
      },
    ],
  };
};

describe('authz-abac: model conformance', () => {
  runModelConformance('AbacModel over a memory store', factory, { timeoutMs: 120_000 });

  // Checks of rows whose scope read faults throw, as they do without the switch.
  runModelConformance('AbacModel with authz.abac.scopeResiduals on', scopeFactory, { timeoutMs: 120_000, indeterminate: 'allow' });

  it('with scopeResiduals on, init registers the filter boot rule 4 asks for, and the engine lists what it checks', async () => {
    // As authz-orm with the leaf's OrmNativeCompiler would declare it (lane A4 task 2).
    const { adapter, resolver } = scopeWorld([...CORE_FILTER_OPS, SCOPE_CONDITION_OP]);
    const m = new AbacModel({ stores: [new MemoryPolicyStore(SCOPE_POLICIES)] });
    const init = fakeModelInitContext({ permissions: SCOPE_PERMISSIONS, config: { scopeResiduals: true } });
    await m.init(init);
    const boot = { domain: 'root', models: [m], registry: init.permissions, adapters: [adapter], scopeResolvers: [resolver], ...m.contribution() };
    chai.expect(() => validateBoot({ ...boot, nativeFilters: [] })).to.throw(/native residual op "native:condition\.scope" has no registered NativeFilter/);
    validateBoot({ ...boot, nativeFilters: init.registered.nativeFilters });

    const a = new Authorizer({ domain: 'root', models: [m], registry: init.permissions, adapters: [adapter], scopeResolvers: [resolver], nativeFilters: init.registered.nativeFilters, conditions: new DefaultConditionCompiler(undefined, [resolver], [adapter]) });
    for (const [who, read, write] of [
      [alice, ['a', 'b'], ['a']],
      [agent, ['a'], ['a']],
    ] as const) {
      for (const [permission, want] of [
        ['file:read', read],
        ['file:write', write],
      ] as const) {
        const typeLevel = await a.check({ principal: who, permission, resource: { type: 'file' } });
        chai.expect(typeLevel.residual.op, `${who.id} ${permission}`).to.not.be.oneOf(['true', 'false']);
        const residual = await a.filter(who, permission, 'file');
        const checked: string[] = [];
        const listed: string[] = [];
        for (const row of worldRows(adapter)) {
          if ((await a.check({ principal: who, permission, resource: row.ref, subject: row.subject })).allowed) checked.push(row.ref.id!);
          const ctx = fakeEvaluationContext({ adapters: [adapter], scopeResolvers: [resolver], nativeFilters: init.registered.nativeFilters, permissions: SCOPE_PERMISSIONS });
          if ((await evaluateFilter(residual, row.subject, { principal: who, ref: row.ref, context: ctx })) === true) listed.push(row.ref.id!);
        }
        chai.expect(checked, `${who.id} ${permission}`).to.deep.equal(want);
        chai.expect(listed, `${who.id} ${permission}`).to.deep.equal(checked);
      }
    }
  });

  it('lists the policies that need the row on list-scoped types (B19 boot warning)', async () => {
    const m = new AbacModel({ stores: [new MemoryPolicyStore([...POLICIES, { id: 'frozen-orgs', effect: 'deny', permissions: ['file:read'], resourceTypes: ['file'], when: { attr: 'scope.org.policies.frozen', eq: true }, source: 'test' }, { id: 'named', effect: 'permit', permissions: ['file:read'], when: { fn: 'glob', args: { value: { ref: 'resource.name' }, pattern: 'a/*' } }, source: 'test' }, { id: 'global-flag', effect: 'permit', permissions: ['file:read'], when: { attr: 'scope.$global.flags.on', eq: true }, source: 'test' }])] });
    await m.init(
      fakeModelInitContext({
        permissions: [
          { name: 'file:read', types: ['file', 'note'] },
          { name: 'file:write', types: ['file'] },
          { name: 'file:delete', types: ['file'] },
        ],
      }),
    );
    chai.expect(m.listWarnings(['file', 'note'])).to.deep.equal(['abac policy "frozen-orgs" on list-scoped type "file": its condition needs the row, so a list request denies needs_subject', 'abac policy "named" on list-scoped type "file": its condition needs the row, so a list request gets nothing from it', 'abac policy "named" on list-scoped type "note": its condition needs the row, so a list request gets nothing from it']);
  });
});
