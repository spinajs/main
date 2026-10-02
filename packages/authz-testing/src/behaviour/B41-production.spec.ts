import { userPrincipal } from '../principals.js';
import { combine, fixture, permit, ref, staticModel } from './dsl.js';
import { http, tracesOnlyAtDebug } from './lane.js';
import type { HttpWorld } from './lane.js';
import type { World } from './types.js';

const alice = userPrincipal('alice');
// bob holds authz:explain.
const bob = userPrincipal('bob');
const f1 = ref('file', 'f1');

const world = (env: HttpWorld['env']): World => ({
  permissions: ['file:read', 'authz:explain'],
  principals: { alice, bob },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.permission === 'authz:explain' && req.principal.id === 'bob' ? permit() : {}) })],
  config: { engine: { explain: true }, http: { explainRoute: { enabled: true } } },
  lane: { http: { env, routes: [{ method: 'GET', path: '/files/:id', access: { permission: 'file:read', resource: { from: 'param', name: 'id', type: 'file' } } }] } },
});

const EXPLAIN = { method: 'GET', path: '/authz/explain?principal=user:alice&permission=file:read&resource=file:f1', as: 'bob' } as const;

export const B41 = fixture('B41', [
  {
    name: 'http',
    facets: ['engine', 'http'],
    lanes: ['L5'],
    note: 'Release gate item 11 (production-mode boot). The boot warning for authz.http.explainRoute.enabled in production (design §11.4) has no fixed message; L5 asserts it. The explain route reads principal and resource as <type>:<id> keys (design §11.4 gives the parameter names only).',
    world: world('production'),
    cases: [
      { name: 'in production the explain route is not registered (404), even when enabled', steps: [http(EXPLAIN, { status: 404 })] },
      { name: 'outside production the enabled explain route is registered', world: world('development'), steps: [http(EXPLAIN, { status: 200, body: { allowed: false, trace: {} } })] },
      { name: 'in production a 403 body carries no trace', steps: [http({ method: 'GET', path: '/files/f1', as: 'bob' }, { status: 403, absent: ['trace'] })] },
      { name: 'in production authz().explain() still returns a trace', steps: [{ explain: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false, trace: true } }] },
      { name: 'with authz.engine.explain traces are logged at debug level only', steps: [http({ method: 'GET', path: '/files/f1', as: 'alice' }, { status: 403 }), tracesOnlyAtDebug()] },
    ],
  },
]);
