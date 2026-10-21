import { AuthorizationModel, AuthzContributor, DecisionAudit, GLOBAL } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';
import { AssignmentStore, ConfigRoleStore, MemoryAdminAssignmentStore, RbacContributor, RbacModel, RbacService, RoleStore } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';

import { fixtureDsl, testHost, userPrincipal } from '../../src/index.js';

const { assignment, combine, role } = fixtureDsl;

const DOMAIN = 'bench';

/** 30 permissions: op00-op19 are granted across the role chain, op20-op29 by no role. */
export const PERMISSIONS = Array.from({ length: 30 }, (_, i) => `item:op${String(i).padStart(2, '0')}`);

// admin extends manager extends editor extends viewer: 4 roles, 3 $extend levels. Each level holds 5 grants.
const CHAIN = ['viewer', 'editor', 'manager', 'admin'];
const ROLES = CHAIN.map((name, level) => role(name, PERMISSIONS.slice(level * 5, level * 5 + 5), level === 0 ? {} : { extends: [CHAIN[level - 1]] }));

export const GRANTED = PERMISSIONS.slice(0, 20);
export const DENIED = PERMISSIONS.slice(20);

class NoAudit extends DecisionAudit {
  record(): void {}
}

export interface BenchHost {
  readonly authz: AuthzService;
  /** Holds only `admin`, assigned at GLOBAL. */
  readonly alice: Principal;
  readonly resource: typeof GLOBAL;
  dispose(): Promise<void>;
}

/**
 * The real DefaultAuthzService over authz-rbac's RbacModel with config roles and in-memory assignments, no decision
 * cache (the L2 would turn a check into a map lookup) and no audit sink (audit cost is not a gate).
 */
export async function bootRbacHost(): Promise<BenchHost> {
  await testHost.installHost();
  const cfg = testHost.config();
  cfg.set(['authz', 'rbac', 'roles'], Object.fromEntries(ROLES.map(({ name, source: _source, ...def }) => [name, def])));
  cfg.set(['authz', 'domains', DOMAIN], {
    permissions: Object.fromEntries(PERMISSIONS.map((p) => [p, {}])),
    combine: combine('deny-overrides', 'rbac'),
    cache: { maxEntries: 0 },
  });

  const alice = userPrincipal('alice');
  const ds = await testHost.domains();
  const container = ds.create(DOMAIN, 'root');
  try {
    const assignments = new MemoryAdminAssignmentStore({ assignments: [assignment('a1', alice, 'admin')] });
    const roles = new ConfigRoleStore((await container.resolve(Configuration)) as Configuration);
    const model = new RbacModel({ roles, assignments });
    container.register(testHost.instance(roles)).as(RoleStore);
    container.register(testHost.instance(assignments)).as(AssignmentStore);
    container.register(testHost.instance(model)).as(AuthorizationModel);
    container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
    container.register(testHost.instance(new RbacService(model))).as(RbacService);
    container.register(testHost.instance(new NoAudit())).as(DecisionAudit);

    const authz = await ds.service(DOMAIN);
    return {
      authz,
      alice,
      resource: GLOBAL,
      dispose: async () => {
        await container.dispose();
        await testHost.uninstallHost();
      },
    };
  } catch (e) {
    await container.dispose();
    await testHost.uninstallHost();
    throw e;
  }
}
