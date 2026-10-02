import type { ScriptedVote, VoteFn } from '../fakes/index.js';
import { agentPrincipal, userPrincipal } from '../principals.js';
import { cmp, combine, deny, fixture, permit, ref, staticModel } from './dsl.js';
import type { Case, World } from './types.js';

const u1 = userPrincipal('u1');
const a1 = agentPrincipal('a1', u1);
const scoped = agentPrincipal('a2', u1, { permissions: ['file:read'] });
const r1 = ref('file', 'r1');
const r2 = ref('file', 'r2');
const rows = {
  file: [
    { id: 'r1', createdBy: 'a1', owner: 'u1' },
    { id: 'r2', createdBy: 'u1', owner: 'a1' },
  ],
};
const AGENT = { type: 'agent', id: 'a1' };

const world = (votes: VoteFn): World => ({
  permissions: ['file:read', 'file:write'],
  principals: { u1, a1, scoped },
  adapters: [{ types: ['file'], rows }],
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes })],
});

const only =
  (id: string, vote: ScriptedVote = permit()): VoteFn =>
  (req) =>
    req.principal.id === id ? vote : {};

const core: Case[] = [
  {
    name: "the agent gets the delegate's answer, and is the decision's actor",
    world: world(only('u1')),
    steps: [{ check: { as: 'a1', permission: 'file:read', resource: r1 }, expect: { allowed: true, actor: AGENT } }],
  },
  {
    name: "the agent's own grants are ignored; the answer never exceeds the delegate's",
    world: world(only('a1')),
    steps: [{ check: { as: 'a1', permission: 'file:read', resource: r1 }, expect: { allowed: false } }],
  },
  {
    name: 'the models see the agent as the actor',
    world: world((req) => (req.principal.id !== 'u1' ? {} : req.actor?.type === 'agent' ? deny({ code: 'agents_disabled', priority: 100 }) : permit())),
    steps: [
      { check: { as: 'a1', permission: 'file:read', resource: r1 }, expect: { allowed: false, reason: 'agents_disabled' } },
      { check: { as: 'u1', permission: 'file:read', resource: r1 }, expect: { allowed: true, actor: null } },
    ],
  },
  {
    name: "the agent's own ceiling still applies",
    world: world(only('u1')),
    steps: [
      { check: { as: 'scoped', permission: 'file:write', resource: r1 }, expect: { allowed: false, reason: 'out_of_scope' } },
      { check: { as: 'scoped', permission: 'file:read', resource: r1 }, expect: { allowed: true } },
    ],
  },
  {
    name: 'actor.* refs read the agent',
    world: world(only('u1', permit(cmp('createdBy', 'eq', { ref: 'actor.id' })))),
    steps: [
      { check: { as: 'a1', permission: 'file:read', resource: r1, subject: 'row' }, expect: { allowed: true } },
      { check: { as: 'a1', permission: 'file:read', resource: r2, subject: 'row' }, expect: { allowed: false } },
    ],
  },
  {
    name: 'principal.* refs read the delegate',
    world: world(only('u1', permit(cmp('owner', 'eq', { ref: 'principal.id' })))),
    steps: [
      { check: { as: 'a1', permission: 'file:read', resource: r1, subject: 'row' }, expect: { allowed: true } },
      { check: { as: 'a1', permission: 'file:read', resource: r2, subject: 'row' }, expect: { allowed: false } },
    ],
  },
];

export const B37 = fixture('B37', [
  { name: 'core', facets: ['engine'], lanes: ['F3'], cases: core },
  { name: 'token', facets: ['token'], lanes: ['C5'], note: 'Agent tokens yielding inherit-agents end to end with RBAC need authn token issuance; C5 proposes the cases by RFC.', cases: [] },
]);
