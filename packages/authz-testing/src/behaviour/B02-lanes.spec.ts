import { userPrincipal } from '../principals.js';
import { combine, extension, permit, staticModel } from './dsl.js';
import { http } from './lane.js';
import type { RouteSpec } from './lane.js';
import type { World } from './types.js';

const alice = userPrincipal('alice');

const world = (route: RouteSpec): World => ({
  permissions: [{ name: 'file:read', types: ['file'] }],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { '*': permit() } })],
  lane: { http: { routes: [route] } },
});

const route = (permission: string, type: string): RouteSpec => ({ method: 'GET', path: '/files/:id', access: { permission, resource: { from: 'param', name: 'id', type } } });

export const B02Lanes = extension('B02', [
  {
    name: 'http',
    facets: ['engine', 'boot', 'http'],
    lanes: ['L5'],
    note: 'Boot rule 7 (design §6.5) covers @Access. B02 is not in the acceptance list of L5; it should run this part with B05.',
    cases: [
      { name: '@Access naming an unregistered permission fails at boot', world: world(route('ghost:read', 'file')), boot: { throws: 'AuthzConfigError', message: ['ghost:read'] }, steps: [] },
      { name: '@Access checking a permission on a type outside its types fails at boot', world: world(route('file:read', 'project')), boot: { throws: 'AuthzConfigError', message: ['file:read', 'project'] }, steps: [] },
      { name: 'control: a registered permission on one of its types boots and serves', world: world(route('file:read', 'file')), steps: [http({ method: 'GET', path: '/files/f1', as: 'alice' }, { status: 200 })] },
    ],
  },
]);
