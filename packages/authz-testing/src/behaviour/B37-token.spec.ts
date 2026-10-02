import { extension, ref } from './dsl.js';
import { actorIsKept, checkKept, token } from './lane.js';
import { tokenWorld } from './B24-token-principals.spec.js';

const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');
const P2 = ref('project', 'p2');

export const B37Token = extension('B37', [
  {
    name: 'token',
    facets: ['engine', 'rbac', 'token'],
    lanes: ['C5'],
    note: "An agent token (Scope.agent) acts for its owner with delegation 'inherit' (design §22.9).",
    world: tokenWorld,
    cases: [
      { name: "an agent token's decision is its owner's, and the agent is the actor", steps: [token('a', { owner: 'alice', scope: { agent: true, permissions: ['file:*'] } }), checkKept('a', { permission: 'file:write', resource: f1 }, { allowed: true }), actorIsKept('a', { permission: 'file:read', resource: f1 })] },
      { name: "an agent token's answer stays inside its Scope", steps: [token('a', { owner: 'alice', scope: { agent: true, permissions: ['file:read'], resources: [P2] } }), checkKept('a', { permission: 'file:read', resource: f1 }, { allowed: false, reason: 'out_of_scope' }), checkKept('a', { permission: 'file:read', resource: f2 }, { allowed: true })] },
      { name: "an agent token's answer never exceeds its owner's", steps: [token('a', { owner: 'alice', scope: { agent: true, permissions: ['*'] } }), checkKept('a', { permission: 'user:impersonate' }, { allowed: false })] },
    ],
  },
]);
