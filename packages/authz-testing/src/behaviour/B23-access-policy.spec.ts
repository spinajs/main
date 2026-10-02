import type { ScriptedVote, VoteFn } from '../fakes/index.js';
import { userPrincipal } from '../principals.js';
import { combine, deny, fixture, permit, staticModel } from './dsl.js';
import { http } from './lane.js';
import type { AccessSpec, HttpWorld, RouteSpec, TestPolicy } from './lane.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice');
// bob holds authz:explain.
const bob = userPrincipal('bob');

const FILE = { from: 'param', name: 'id', type: 'file' } as const;
const PASSES: TestPolicy = { name: 'Passes', passes: true };
const FAILS: TestPolicy = { name: 'Fails', passes: false };

const route = (access: Partial<AccessSpec> = {}, extra: Partial<RouteSpec> = {}): RouteSpec => ({ method: 'GET', path: '/files/:id', access: { permission: 'file:read', resource: FILE, ...access }, ...extra });

/** m1 votes `file` for every permission of `permissions` and permits authz:explain for bob. */
const votes =
  (file: Readonly<Record<string, ScriptedVote>>): VoteFn =>
  (req) =>
    req.permission === 'authz:explain' ? (req.principal.id === 'bob' ? permit() : {}) : file[req.permission] ?? {};

const world = (routes: RouteSpec[], file: Readonly<Record<string, ScriptedVote>>, extra: { readonly http?: Partial<HttpWorld>; readonly explain?: boolean } = {}): World => ({
  permissions: ['file:read', 'file:write', 'authz:explain'],
  principals: { alice, bob },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: votes(file) })],
  ...(extra.explain !== undefined ? { config: { engine: { explain: extra.explain } } } : {}),
  lane: { http: { routes, ...extra.http } },
});

const READ = { 'file:read': permit() };
const GET = (as: string) => ({ method: 'GET', path: '/files/f1', as } as const);

const LOCKED = { code: 'locked', priority: 50, sortKey: 'k', detail: 'd' };

const httpCases: Case[] = [
  { name: '@Access and a passing also policy: the group passes', world: world([route({ also: [PASSES] })], READ), steps: [http(GET('alice'), { status: 200 })] },
  { name: '@Access and its also policies are AND: a failing also policy fails the group', world: world([route({ also: [FAILS] })], READ), steps: [http(GET('alice'), { status: 403 })] },
  { name: '@Access and its also policies are AND: a denied permission fails the group', world: world([route({ also: [PASSES] })], {}), steps: [http(GET('alice'), { status: 403 })] },
  { name: 'several permissions in one @Access are any of', world: world([route({ permission: ['file:read', 'file:write'] })], { 'file:write': permit() }), steps: [http(GET('alice'), { status: 200 })] },
  { name: 'several permissions in one @Access: none allowed is 403', world: world([route({ permission: ['file:read', 'file:write'] })], {}), steps: [http(GET('alice'), { status: 403 })] },
  { name: 'a separate @Policy stays OR: it lets the request through when @Access denies', world: world([route({}, { policies: [PASSES] })], {}), steps: [http(GET('alice'), { status: 200 })] },
  { name: 'a separate @Policy stays OR: both failing is 403', world: world([route({}, { policies: [FAILS] })], {}), steps: [http(GET('alice'), { status: 403 })] },
  {
    name: 'a denial is 403 { error, permission, resource, reason } with the reason payload, without priority and sortKey',
    world: world([route()], { 'file:read': deny(LOCKED) }),
    steps: [http(GET('alice'), { status: 403, body: { error: 'forbidden', permission: 'file:read', resource: { type: 'file', id: 'f1' }, reason: { code: 'locked', detail: 'd' } }, absent: ['reason.priority', 'reason.sortKey'] })],
  },
  { name: 'no trace in a 403 in production, even with explain on and a caller holding authz:explain', world: world([route()], {}, { explain: true, http: { env: 'production' } }), steps: [http(GET('bob'), { status: 403, absent: ['trace'] })] },
  { name: 'outside production a 403 carries a trace when explain is on and the caller holds authz:explain', world: world([route()], {}, { explain: true, http: { env: 'development' } }), steps: [http(GET('bob'), { status: 403, body: { trace: {} } })] },
  { name: 'outside production, no trace when explain is off', world: world([route()], {}, { explain: false, http: { env: 'development' } }), steps: [http(GET('bob'), { status: 403, absent: ['trace'] })] },
  { name: 'outside production, no trace for a caller without authz:explain', world: world([route()], {}, { explain: true, http: { env: 'development' } }), steps: [http(GET('alice'), { status: 403, absent: ['trace'] })] },
];

// Design §18.1: telemetry.auth.policies.<endpoint>: 'AccessPolicy' + telemetry.auth.permissions.<endpoint>.
const telemetryWorld: World = {
  permissions: ['telemetry:read'],
  principals: { alice, bob },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.principal.id === 'bob' ? permit() : {}) })],
  lane: {
    http: {
      routes: [{ method: 'GET', path: '/metrics', configPolicy: 'telemetry.auth.policies.metrics' }],
      config: { telemetry: { auth: { policies: { metrics: 'AccessPolicy' }, permissions: { metrics: 'telemetry:read' } } } },
    },
  },
};

export const B23 = fixture('B23', [
  { name: 'http', facets: ['engine', 'http'], lanes: ['L5', 'C2', 'C6'], note: 'The 403 body names the resource as the decision does (a ResourceRef); the trace key is `trace`.', cases: httpCases },
  {
    name: 'configNamed',
    facets: ['engine', 'http'],
    lanes: ['C7'],
    world: telemetryWorld,
    cases: [
      { name: "a config-named policy slot set to 'AccessPolicy' checks the configured permission: allowed", steps: [http({ method: 'GET', path: '/metrics', as: 'bob' }, { status: 200 })] },
      { name: "a config-named policy slot set to 'AccessPolicy' checks the configured permission: denied", steps: [http({ method: 'GET', path: '/metrics', as: 'alice' }, { status: 403, body: { permission: 'telemetry:read' } })] },
    ],
  },
]);
