import assert from 'node:assert/strict';
import 'mocha';

import { AuthorizationModel, AuthzContributor, GLOBAL } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';
import { AssignmentStore, ConfigRoleStore, MemoryAdminAssignmentStore, RbacContributor, RbacModel, RbacService, RoleStore } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';

import { hostHarness, runBehaviour, testHost, withAuthn, withCeiling } from '../../src/index.js';
import type { AuthnHandle, BehaviourHarness, HttpHandle } from '../../src/index.js';

const { instance } = testHost;

// users' AuthzTargetGuard default (C3); kept here, as the kit cannot import users.
const PROTECTED_ROLES = ['admin'];

// The http form of the summary: what GET /user/access sends and a flow body carries (dates as ISO strings).
const accessOf = async (authz: AuthzService, p: Principal): Promise<unknown> => JSON.parse(JSON.stringify(await authz.summary(p)));

/**
 * B25.authn on the kit's host harness with authz-rbac's RbacModel over the world's roles and assignments. The authn and
 * http handles are stubs that only prove each flow is satisfiable with real rights; they do not re-implement authn.
 */
function rbacHostHarness(): BehaviourHarness {
  return hostHarness({
    facets: ['rbac', 'http', 'authn'],
    async register(host) {
      const c = host.container;
      const rbac = host.world.rbac!;
      host.setConfig(['authz', 'rbac', 'roles'], Object.fromEntries((rbac.roles ?? []).map(({ name, source: _source, ...def }) => [name, def])));

      const assignments = new MemoryAdminAssignmentStore({ assignments: rbac.assignments });
      const roles = new ConfigRoleStore((await c.resolve(Configuration)) as Configuration);
      const model = new RbacModel({ roles, assignments, clock: host.kit.clock });
      c.register(instance(roles)).as(RoleStore);
      c.register(instance(assignments)).as(AssignmentStore);
      c.register(instance(model)).as(AuthorizationModel);
      c.register(instance(new RbacContributor(model))).as(AuthzContributor);
      c.register(instance(new RbacService(model))).as(RbacService);
    },
    async extend(host, session) {
      const authz = session.authz as unknown as AuthzService;
      const rbac = (await host.container.resolve(RbacService)) as RbacService;
      const heldRoles = async (p: Principal) => (await rbac.rolesOf(p, GLOBAL, { ceiling: false })).map((h) => h.role);

      const http: HttpHandle = {
        async request(req) {
          assert.equal(`${req.method} ${req.path}`, 'GET /user/access', 'the stub answers GET /user/access only');
          return req.principal ? { status: 200, body: await accessOf(authz, req.principal) } : { status: 401, body: null };
        },
        logs: () => [],
      };

      const authn: AuthnHandle = {
        async flow(f) {
          let principal: Principal;
          if (f.kind === 'roleSwitch') {
            assert.ok((await heldRoles(f.as)).includes(f.role), `${f.as.id} does not hold ${f.role}`);
            principal = withCeiling(withAuthn(f.as), { roles: [f.role] });
          } else if (f.kind === 'impersonation') {
            const actor = withAuthn(f.as);
            const target = withAuthn(f.target, { impersonator: { type: actor.type, id: actor.id } });
            assert.ok(await authz.can(actor, 'user:impersonate', GLOBAL), `${actor.id} lacks user:impersonate at GLOBAL`);
            assert.ok(!(await heldRoles(target)).some((r) => PROTECTED_ROLES.includes(r)), `${target.id} holds a protected role`);
            assert.ok(await authz.covers(actor, target, GLOBAL), `${actor.id} does not cover ${target.id}`);
            principal = target;
          } else {
            principal = withAuthn(f.as, f.kind === 'mfa' ? { mfa: ['totp'] } : {});
          }
          return { status: 200, body: { Access: await accessOf(authz, principal) }, principal };
        },
      };

      return { lane: { http, authn } };
    },
  });
}

describe('B25.authn on a real RBAC host world (RFC C3-2)', function () {
  this.timeout(60000);

  runBehaviour(['B25.authn'], rbacHostHarness, { strict: true });
});
