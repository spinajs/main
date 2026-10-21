import { userPrincipal } from '../principals.js';
import { cmp, combine, fixture, permit, staticModel } from './dsl.js';
import { http } from './lane.js';
import type { AccessSpec, RouteSpec } from './lane.js';
import type { World } from './types.js';

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');

const INVOICE = { from: 'param', name: 'id', type: 'invoice' } as const;
const MEMO = { from: 'param', name: 'id', type: 'memo' } as const;

const route = (path: string, access: AccessSpec): RouteSpec => ({ method: 'GET', path, access, handler: 'decision' });

// The owner rule: every principal reads the invoices and memos it owns, a residual until the row is known.
const world: World = {
  permissions: ['invoice:read', 'memo:read'],
  principals: { alice, bob },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => permit(cmp('owner', 'eq', req.principal.id)) })],
  adapters: [{ types: ['invoice'], rows: { invoice: [{ id: 'i1', owner: 'alice' }, { id: 'i2', owner: 'bob' }] } }],
  lane: {
    http: {
      routes: [
        route('/invoices/:id', { permission: 'invoice:read', resource: INVOICE }),
        route('/action/:id', { permission: 'invoice:read', resource: INVOICE, conditional: 'action' }),
        route('/memos/:id', { permission: 'memo:read', resource: MEMO }),
        route('/invoices', { permission: 'invoice:read' }),
      ],
    },
  },
};

const GET = (path: string) => ({ method: 'GET', path, as: 'alice' }) as const;

export const B47 = fixture('B47', [
  {
    name: 'http',
    facets: ['engine', 'http'],
    lanes: [],
    note: 'The owner rule is a static model vote: the http harness carries no RBAC model.',
    world,
    cases: [
      { name: 'owner-rule-other-id: a conditional allow on another owner\'s row is 403 with the reason of the check against the row', steps: [http(GET('/invoices/i2'), { status: 403, body: { reason: { code: 'residual_false' } } })] },
      { name: 'owner-rule-own-id: the owner reaches the action with a TRUE residual in AuthzDecision', steps: [http(GET('/invoices/i1'), { status: 200, body: { allowed: true, residual: 'true' } })] },
      { name: "opt-out-action: conditional: 'action' runs the action with the residual left in AuthzDecision", steps: [http(GET('/action/i2'), { status: 200, body: { allowed: true, residual: 'cmp' } })] },
      { name: 'no-loader: a conditional allow on a type no ResourceAdapter can load is 403 unknown_resource', steps: [http(GET('/memos/m1'), { status: 403, body: { reason: { code: 'unknown_resource' } } })] },
      { name: 'type-only-resource: a type-level conditional allow runs the action and keeps its residual for .accessible()', steps: [http(GET('/invoices'), { status: 200, body: { allowed: true, residual: 'cmp' } })] },
    ],
  },
]);
