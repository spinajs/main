import type { Principal } from '@spinajs/authz';

import type { ScriptedVote, VoteFn } from '../fakes/index.js';
import { servicePrincipal, userPrincipal } from '../principals.js';
import { cmp, combine, fixture, permit, ref, staticModel } from './dsl.js';
import type { Case, World } from './types.js';

const u1 = userPrincipal('u1');
const intersect = (id: string, onBehalfOf: Principal): Principal => servicePrincipal(id, { onBehalfOf, delegation: 'intersect' });
const svc = intersect('svc', u1);
const s1 = intersect('s1', u1);
const s2 = intersect('s2', s1);
const s3 = intersect('s3', s2);

const r1 = ref('file', 'r1');
const rows = {
  file: [
    { id: 'r1', status: 'open', team: 't1' },
    { id: 'r2', status: 'open', team: 't2' },
    { id: 'r3', status: 'closed', team: 't1' },
  ],
};

/** Votes per principal id; anyone else has no opinion. */
const byPrincipal =
  (votes: Readonly<Record<string, ScriptedVote>>): VoteFn =>
  (req) =>
    votes[req.principal.id] ?? {};

const world = (votes: Readonly<Record<string, ScriptedVote>>, extra: Partial<World> = {}): World => ({
  permissions: ['file:read'],
  principals: { u1, svc, s1, s2, s3 },
  adapters: [{ types: ['file'], rows }],
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: byPrincipal(votes) })],
  ...extra,
});

const core: Case[] = [
  { name: 'allowed when the principal and the delegate are both allowed', world: world({ svc: permit(), u1: permit() }), steps: [{ check: { as: 'svc', permission: 'file:read', resource: r1 }, expect: { allowed: true } }] },
  { name: 'the delegate denied ⇒ deny with reason delegate', world: world({ svc: permit() }), steps: [{ check: { as: 'svc', permission: 'file:read', resource: r1 }, expect: { allowed: false, reason: 'delegate', residual: 'FALSE' } }] },
  { name: 'the principal denied ⇒ deny, even when the delegate is allowed', world: world({ u1: permit() }), steps: [{ check: { as: 'svc', permission: 'file:read', resource: r1 }, expect: { allowed: false, reason: 'no_access' } }] },
  {
    name: 'residuals are AND-ed',
    world: world({ svc: permit(cmp('status', 'eq', 'open')), u1: permit(cmp('team', 'eq', 't1')) }),
    steps: [{ check: { as: 'svc', permission: 'file:read' }, expect: { allowed: true, residual: { selects: ['r1'] } } }],
  },
  {
    name: 'delegation deeper than maxDelegation (default 2) throws AuthzConfigError',
    world: world({ s3: permit(), s2: permit(), s1: permit(), u1: permit() }),
    steps: [{ check: { as: 's3', permission: 'file:read', resource: r1 }, expect: { throws: 'AuthzConfigError' } }],
  },
  {
    name: 'delegation deeper than a configured maxDelegation throws AuthzConfigError',
    world: world({ s2: permit(), s1: permit(), u1: permit() }, { config: { engine: { maxDelegation: 1 } } }),
    steps: [{ check: { as: 's2', permission: 'file:read', resource: r1 }, expect: { throws: 'AuthzConfigError' } }],
  },
  // maxDelegation counts onBehalfOf hops (D-F5-3): s2 -> s1 -> u1 is two.
  {
    name: 'a chain of two hops is allowed under the default maxDelegation (2)',
    world: world({ s2: permit(), s1: permit(), u1: permit() }),
    steps: [{ check: { as: 's2', permission: 'file:read', resource: r1 }, expect: { allowed: true } }],
  },
  {
    name: 'one hop is allowed under maxDelegation 1',
    world: world({ s1: permit(), u1: permit() }, { config: { engine: { maxDelegation: 1 } } }),
    steps: [{ check: { as: 's1', permission: 'file:read', resource: r1 }, expect: { allowed: true } }],
  },
];

export const B08 = fixture('B08', [
  { name: 'core', facets: ['engine'], lanes: ['F3'], cases: core },
  { name: 'token', facets: ['token'], lanes: ['C5'], note: 'Delegated tokens end to end with RBAC need authn token issuance; C5 proposes the cases by RFC.', cases: [] },
]);
