import { extension, ref } from './dsl.js';
import { checkKept, token } from './lane.js';
import { tokenWorld } from './B24-token-principals.spec.js';

const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');
const P1 = ref('project', 'p1');

export const B07Token = extension('B07', [
  {
    name: 'token',
    facets: ['engine', 'rbac', 'token'],
    lanes: ['C5'],
    note: "A token's ceiling: roles from the token, permissions and resources from its Scope; no Scope reason ⇒ 'ceiling' (design §5.1, §22.9).",
    world: tokenWorld,
    cases: [
      { name: 'token roles never add a role the owner lacks', steps: [token('t', { owner: 'alice', roles: ['admin'] }), checkKept('t', { permission: 'user:impersonate' }, { allowed: false })] },
      { name: 'a permission outside the Scope is denied with reason ceiling', steps: [token('t', { owner: 'alice', scope: { permissions: ['file:read'] } }), checkKept('t', { permission: 'file:write', resource: f1 }, { allowed: false, reason: 'ceiling' })] },
      { name: 'a resource outside the Scope is denied with reason ceiling', steps: [token('t', { owner: 'alice', scope: { resources: [P1] } }), checkKept('t', { permission: 'file:read', resource: f2 }, { allowed: false, reason: 'ceiling' }), checkKept('t', { permission: 'file:read', resource: f1 }, { allowed: true })] },
      { name: 'no role bypasses the Scope', steps: [token('t', { owner: 'alice', roles: ['viewer', 'editor'], scope: { permissions: ['file:read'] } }), checkKept('t', { permission: 'file:write', resource: f1 }, { allowed: false, reason: 'ceiling' })] },
    ],
  },
]);
