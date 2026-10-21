import { userPrincipal } from '../principals.js';
import { combine, fixture, permit, staticModel } from './dsl.js';
import { http } from './lane.js';
import type { World } from './types.js';

const alice = userPrincipal('alice');

// The http harness registers an AuthzDomainResolver that reads the domain from the `x-authz-domain` header.
const DOMAIN_HEADER = 'x-authz-domain';

const world: World = {
  permissions: ['file:read'],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1')],
  domains: { tenant1: { models: [staticModel('m3', { votes: { 'file:read': permit() } })], combine: combine('deny-overrides', 'm1', 'm3') } },
  lane: { http: { routes: [{ method: 'GET', path: '/files/:id', access: { permission: 'file:read', resource: { from: 'param', name: 'id', type: 'file' } }, handler: 'decision' }] } },
};

const GET = (domain?: string) => ({ method: 'GET', path: '/files/f1', as: 'alice', ...(domain ? { headers: { [DOMAIN_HEADER]: domain } } : {}) }) as const;

export const B48 = fixture('B48', [
  {
    name: 'http',
    facets: ['engine', 'http'],
    lanes: [],
    world,
    cases: [
      { name: "no-header: the resolver returns the route's domain, which denies", steps: [http(GET(), { status: 403, body: { reason: { code: 'no_access' } } })] },
      { name: 'child-domain: the domain the resolver names decides, and its decision is the one the action sees', steps: [http(GET('tenant1'), { status: 200, body: { allowed: true } })] },
    ],
  },
]);
