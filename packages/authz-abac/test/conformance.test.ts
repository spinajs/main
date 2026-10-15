import 'mocha';
import { DefaultConditionCompiler } from '@spinajs/authz';
import type { Policy } from '@spinajs/authz';
import { FakeAdapter, FakeScopeResolver, agentPrincipal, runModelConformance, servicePrincipal, userPrincipal, worldRows } from '@spinajs/authz-testing';
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

describe('authz-abac: model conformance', () => {
  runModelConformance('AbacModel over a memory store', factory, { timeoutMs: 120_000 });
});
