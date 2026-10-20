import 'mocha';
import { hostHarness, runBehaviour, testHost } from '@spinajs/authz-testing';

import { AdminGuard, AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';

import { AbacContributor, AbacModel, MemoryPolicyStore, PolicyStore } from '../../src/index.js';

class PermissivePolicyGuard extends AdminGuard {
  async check(): Promise<void> {}
}

// The kit parts that write policies through AuthzAdmin: the real AbacModel named 'abac' over a
// MemoryPolicyStore holding world.abac.policies, the same instance registered as PolicyStore.
runBehaviour(
  ['B43.policies', 'B27.policyEvents'],
  () =>
    hostHarness({
      facets: ['admin', 'abac', 'conditions'],
      register(host) {
        const c = host.container;
        const store = new MemoryPolicyStore((host.world.abac?.policies ?? []).map((p) => ({ ...p, source: 'memory' })));
        const model = new AbacModel({ stores: [store] });
        c.register(testHost.instance(model)).as(AuthorizationModel);
        c.register(testHost.instance(new AbacContributor(model))).as(AuthzContributor);
        c.register(testHost.instance(store)).as(PolicyStore);
        c.register(PermissivePolicyGuard).as(AdminGuard);
        host.setConfig(['authz', 'admin', 'guard', 'service'], 'PermissivePolicyGuard');
      },
      extend: (_host, session) => ({ admin: (session.authz as unknown as AuthzService).admin() }),
    }),
  { strict: true },
);
