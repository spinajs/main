// 2.x baseline: probeGrant / effectiveRoles. Imports the 2.x sources directly (bench/ is outside
// the published package, so the "no users* dependency in authz*" rule does not apply here).
import { AccessControl } from 'accesscontrol';
import { DI } from '@spinajs/di';
import { User } from '../../../users/src/models/User.js';
import { effectiveRoles, probeGrant } from '../../../users/src/permission-service.js';
import type { Scenario } from '../lib.js';

const RESOURCE_COUNT = 20;
const resources = Array.from({ length: RESOURCE_COUNT }, (_, i) => `res${String(i).padStart(2, '0')}`);

/** viewer -> editor -> manager -> admin via $extend; own/any split across resources. */
function buildGrants() {
  const grants: Record<string, Record<string, unknown>> = {
    viewer: {},
    editor: { $extend: ['viewer'] },
    manager: { $extend: ['editor'] },
    admin: { $extend: ['manager'] },
    auditor: {},
  };

  resources.forEach((res, i) => {
    grants.viewer[res] = { 'read:own': ['*'] };
    (grants.editor as Record<string, unknown>)[res] = { 'create:own': ['*'], 'update:own': ['*'], 'read:any': ['*', '!secret'] };
    if (i % 2 === 0) {
      (grants.manager as Record<string, unknown>)[res] = { 'update:any': ['*'], 'delete:own': ['*'] };
    }
    (grants.admin as Record<string, unknown>)[res] = { 'delete:any': ['*'] };
    (grants.auditor as Record<string, unknown>)[res] = { 'read:any': ['*'] };
  });

  addLadders(grants);

  return grants;
}

const LADDER_DEPTH = 3;
const LADDER_RES = 'ladres';

/**
 * Depth ladders: `<prefix>0` holds the resource, `<prefix>N` extends `<prefix>N-1`. `attrs(level)`
 * gives the read:own attributes a level holds, or undefined when it holds no grant for the resource.
 * One resource and one action everywhere, so only the hierarchy depth (and, in the fold variants,
 * the attribute lists unioned) differs between rows.
 */
function addLadder(grants: Record<string, Record<string, unknown>>, prefix: string, attrs: (level: number) => string[] | undefined) {
  for (let level = 0; level <= LADDER_DEPTH; level++) {
    const role: Record<string, unknown> = level ? { $extend: [`${prefix}${level - 1}`] } : {};
    const a = attrs(level);
    if (a) {
      role[LADDER_RES] = { 'read:own': a };
    }
    grants[`${prefix}${level}`] = role;
  }
}

function addLadders(grants: Record<string, Record<string, unknown>>) {
  addLadder(grants, 'lad', (l) => (l === 0 ? ['*'] : undefined));
  addLadder(grants, 'fstar', () => ['*']);
  addLadder(grants, 'fneg', () => ['*', '!secret']);
  addLadder(grants, 'fempty', (l) => (l === 0 ? ['*', '!secret'] : []));
}

function fakeUser(id: number, roles: string[]): User {
  const user = Object.create(User.prototype) as User;
  (user as { Id: number }).Id = id;
  (user as { Role: string[] }).Role = roles;
  return user;
}

function setup() {
  const ac = new AccessControl();
  ac.setGrants(buildGrants());
  DI.register(ac).asValue('AccessControl', true);
}

const user = fakeUser(7, ['editor', 'auditor']);
let sink = 0;
const activeStore = { User: user, ActiveRole: 'editor' };

const common = { setup, iterations: 200_000, warmup: 20_000 };

function expectGranted(roles: string[], action: string, resource: string, granted: boolean | null) {
  const got = probeGrant(roles, action, resource);
  const actual = got === null ? null : got.granted;
  if (actual !== granted) {
    throw new Error(`probeGrant(${roles.join(',')}, ${action}, ${resource}) answered ${String(actual)}, expected ${String(granted)}`);
  }
}

function probe(name: string, description: string, roles: string[], action: string, resource: string, extra: Partial<Scenario> = {}): Scenario {
  return {
    ...common,
    ...extra,
    name,
    description,
    verify: () => expectGranted(roles, action, resource, true),
    run: () => {
      sink += probeGrant(roles, action, resource)?.granted ? 1 : 0;
    },
  };
}

const scenarios: Scenario[] = [
  probe('probeGrant.warm', 'one role, hit through a 3-level $extend chain (admin -> manager -> editor -> viewer), same args every call', ['admin'], 'readAny', 'res07'),
  probe('probeGrant.warm.shallow', 'one role, hit through a 1-level $extend (editor -> viewer)', ['editor'], 'readOwn', 'res05'),
  probe('probeGrant.warm.multi-role', 'two roles, same list every call', ['editor', 'auditor'], 'readAny', 'res13'),
  {
    ...common,
    name: 'probeGrant.warm.deny',
    description: 'known role, ungranted action (answers granted=false)',
    verify: () => expectGranted(['viewer'], 'deleteAny', 'res03', false),
    run: () => {
      sink += probeGrant(['viewer'], 'deleteAny', 'res03')?.granted ? 1 : 0;
    },
  },
  {
    ...common,
    name: 'probeGrant.unknown-role',
    description: 'role absent from the grants map: accesscontrol throws, probeGrant catches and answers null',
    iterations: 50_000,
    warmup: 5_000,
    verify: () => expectGranted(['ghost'], 'readAny', 'res07', null),
    run: () => {
      sink += probeGrant(['ghost'], 'readAny', 'res07') ? 1 : 0;
    },
  },

  // Depth ladder: same action (readOwn), same resource, same attribute shape (['*'] held by the root
  // role only); only the number of $extend levels between the asked role and the grant changes.
  ...[0, 1, 2, 3].map((d) =>
    probe(`probeGrant.depth${d}`, `${d} $extend level(s); the grant sits on the root role, attribute list ['*']`, [`lad${d}`], 'readOwn', LADDER_RES),
  ),
  // Attribute fold at depth 3: every level holds the resource, so accesscontrol unions four lists.
  probe('probeGrant.depth3.fold-star', "depth 3, every level holds read:own ['*'] (four identical lists unioned)", ['fstar3'], 'readOwn', LADDER_RES),
  probe('probeGrant.depth3.fold-negated', "depth 3, every level holds read:own ['*', '!secret'] (four negated-glob lists unioned)", ['fneg3'], 'readOwn', LADDER_RES),
  probe('probeGrant.depth3.fold-empty', "depth 3, root holds ['*', '!secret'], the three levels above hold [] (warm folds [], negated, [] in that order, so this is cheaper than warm)", ['fempty3'], 'readOwn', LADDER_RES),

  {
    ...common,
    name: 'effectiveRoles',
    description: 'ActiveRole rule against a plain storage object (the middleware calls it on an existing ALS store)',
    batch: 10,
    verify: () => {
      const roles = effectiveRoles(user, { User: user, ActiveRole: 'editor' });
      if (roles.length !== 1 || roles[0] !== 'editor') {
        throw new Error(`effectiveRoles answered ${roles.join(',')}, expected editor`);
      }
    },
    run: () => {
      sink += effectiveRoles(user, activeStore).length;
    },
  },
  {
    ...common,
    name: 'authorize.2x-query-decision',
    description: 'what RbacModelPermissionMiddleware.context() does per query: effectiveRoles + readAny + readOwn probes',
    compare: 'probeGrant.warm.multi-role',
    verify: () => {
      const roles = effectiveRoles(user, { User: user });
      expectGranted(roles, 'readAny', 'res09', true);
      expectGranted(roles, 'readOwn', 'res09', true);
    },
    run: () => {
      const roles = effectiveRoles(user, { User: user });
      const canAny = probeGrant(roles, 'readAny', 'res09')?.granted ?? false;
      const canOwn = probeGrant(roles, 'readOwn', 'res09')?.granted ?? false;
      sink += (canAny ? 1 : 0) + (canOwn ? 1 : 0);
    },
  },
];

export default scenarios;
export { sink };
