import assert from 'node:assert/strict';
import 'mocha';

import { AuthorizationModel, AuthzContributor, AuthzService, SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AssignmentStore, ConfigRoleStore, MemoryAdminAssignmentStore, RbacContributor, RbacModel, RbacService, RoleStore } from '@spinajs/authz-rbac';
import type { RoleDef } from '@spinajs/authz-rbac';
import { PrincipalFactory } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';
import { CookieJar, send } from '@spinajs/authn-testing';
import type { HttpPort, HttpResponse, ProbeBody } from '@spinajs/authn-testing';
import { hostHarness, runBehaviour, testHost } from '@spinajs/authz-testing';
import type { AuthnFlow, AuthnHandle, AuthnResult, BehaviourHarness, HostSetup, HttpHandle } from '@spinajs/authz-testing';

import { UserPrincipalFactory, userModel } from '../../src/index.js';
import type { User } from '../../src/index.js';
import { ROUTES, removeAccounts, resetAuthnCaseServices, seedAccount, startUsersHttpApp, stopUsersHttpApp, useMfaStep, usersHttpApp } from '../support/http-app.js';

const { instance } = testHost;

interface Account {
  readonly ref: IdentityRef;
  readonly login: string;
  readonly password: string;
}

/**
 * users' UserPrincipalFactory, except that it finds a user by any Uuid: the world's principals are `user:alice` and the
 * like, and the factory's `whereUuid` refuses ids that are not v4 uuids. Building the principal, the status refusals and
 * the attribute providers stay users' own.
 */
class WorldIdPrincipalFactory extends UserPrincipalFactory {
  protected async load(id: IdentityRef): Promise<User> {
    if (id?.type !== 'user') return super.load(id);
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    const user = await authz.runAs(SYSTEM, 'world principal', () => userModel().query().where('Uuid', id.id).populate('Metadata').first());
    if (!user) throw new ResourceNotFound(`No user ${id.id}`);
    return user as User;
  }
}

function useWorldIdPrincipals(): () => void {
  const fresh = () => {
    for (const t of [PrincipalFactory, UserPrincipalFactory, WorldIdPrincipalFactory] as unknown as Class<unknown>[]) DI.uncache(t);
  };
  const undo = testHost.registerInRoot(PrincipalFactory as unknown as Class<PrincipalFactory>, WorldIdPrincipalFactory);
  fresh();
  return () => {
    undo();
    fresh();
  };
}

const roleConfig = (roles: readonly RoleDef[]) => Object.fromEntries(roles.map(({ name, source: _source, ...def }) => [name, def]));

/** The principal the probe echoes for the session in `jar`, as authz takes it. */
async function sessionPrincipal(h: { http: HttpPort }, jar: CookieJar): Promise<Principal | null> {
  const res = await send(h, { method: 'GET', path: h.http.probePath }, jar);
  assert.equal(res.status, 200, `probe: ${JSON.stringify(res.body)}`);
  const p = (res.body as ProbeBody).principal;
  if (!p) return null;
  return { ...p, authenticated: true, ...(p.authn ? { authn: { ...p.authn, authenticatedAt: new Date(p.authn.authenticatedAt) } } : {}) } as unknown as Principal;
}

function expectOk(res: HttpResponse, what: string): void {
  assert.equal(res.status, 200, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
}

/**
 * B25.authn and B24.roleSwitch on the kit's host harness, with every flow a real request to authn-http's 3.0 routes of the
 * users http app: users' RbacRoleSource, AuthzImpersonationGuard, AccessResponseExtension and UserPrincipalFactory
 * answer, over authz-rbac's RbacModel of the world's roles and assignments in the test domain, which is the access domain.
 * World principals `user:<id>` are users rows whose Uuid is the id.
 */
function usersHostHarness(): BehaviourHarness {
  return hostHarness({
    facets: ['rbac', 'http', 'authn'],
    async register(host: HostSetup) {
      const c = host.container;
      const rbac = host.world.rbac!;
      host.setConfig(['authz', 'http', 'access', 'domain'], host.domain);
      // The world's RBAC section replaces the app's (installed packages add roles and service roles the world lacks).
      host.setConfig(['authz', 'rbac'], { roles: roleConfig((rbac.roles ?? []) as readonly RoleDef[]) });

      const assignments = new MemoryAdminAssignmentStore({ assignments: rbac.assignments });
      const roles = new ConfigRoleStore(testHost.config());
      const model = new RbacModel({ roles, assignments, clock: host.kit.clock });
      c.register(instance(roles)).as(RoleStore);
      c.register(instance(assignments)).as(AssignmentStore);
      c.register(instance(model)).as(AuthorizationModel);
      c.register(instance(new RbacContributor(model))).as(AuthzContributor);
      c.register(instance(new RbacService(model))).as(RbacService);
    },

    async extend(host: HostSetup) {
      resetAuthnCaseServices();
      const step = useMfaStep();
      const h = { http: usersHttpApp().httpPort() };
      const accounts = new Map<string, Account>();
      const dispose = () => removeAccounts([...accounts.values()].map((a) => a.ref));

      try {
        for (const p of Object.values(host.world.principals ?? {})) {
          if (p.type !== 'user' || accounts.has(p.id)) continue;
          const login = `${p.id}@users.test`;
          const password = `${p.id}-Pass-2468`;
          accounts.set(p.id, { ref: await seedAccount({ login, password, uuid: p.id }), login, password });
        }
      } catch (e) {
        await dispose();
        throw e;
      }

      const account = (p: Principal): Account => {
        const a = accounts.get(p.id);
        assert.ok(p.type === 'user' && a, `no users row for the world principal ${p.type}:${p.id}`);
        return a;
      };
      // The session behind each principal a flow returned, so GET /user/access runs as that very session.
      const sessions = new WeakMap<Principal, CookieJar>();

      const authn: AuthnHandle = {
        async flow(f: AuthnFlow): Promise<AuthnResult> {
          const actor = account(f.as);
          const jar = new CookieJar();
          const aal2 = f.kind === 'mfa' || f.kind === 'impersonation';
          if (aal2) step.enrol(actor.ref);

          let res = await send(h, ROUTES.login!(actor.login, actor.password), jar);
          expectOk(res, `login of ${actor.login}`);
          if (aal2) {
            res = await send(h, ROUTES.mfaVerify!(step.nextCode(actor.ref)), jar);
            if (f.kind === 'impersonation') expectOk(res, `MFA of ${actor.login}`);
          }
          // No authz.principals.roleSwitch.requirePassword: every role asks for the password; impersonation keeps
          // requirePassword and requireMfa on.
          if (f.kind === 'roleSwitch') res = await send(h, ROUTES.activeRoleSet!(f.role, actor.password), jar);
          if (f.kind === 'impersonation') res = await send(h, ROUTES.impersonateStart!({ type: 'user', id: account(f.target).ref.id }, actor.password), jar);

          const principal = await sessionPrincipal(h, jar);
          if (principal) sessions.set(principal, jar);
          return { status: res.status, body: res.body, principal };
        },
      };

      const http: HttpHandle = {
        async request(req) {
          let jar = new CookieJar();
          if (req.principal) {
            const held = sessions.get(req.principal);
            assert.ok(held, `${req.method} ${req.path}: the principal ${req.principal.type}:${req.principal.id} comes from no session of an authn flow`);
            jar = held;
          }
          const res = await send(h, { method: req.method, path: req.path, ...(req.body !== undefined ? { body: req.body } : {}), ...(req.headers ? { headers: req.headers } : {}) }, jar);
          return { status: res.status, body: res.body };
        },
        logs: () => [],
      };

      return { lane: { http, authn }, dispose };
    },
  });
}

describe('B25.authn and B24.roleSwitch over http on users hooks (C3b)', function () {
  this.timeout(60000);
  let undoPrincipals: (() => void) | undefined;

  before(async function () {
    this.timeout(120000);
    await startUsersHttpApp();
    undoPrincipals = useWorldIdPrincipals();
  });

  after(async function () {
    this.timeout(60000);
    undoPrincipals?.();
    await stopUsersHttpApp();
  });

  runBehaviour(['B25.authn', 'B24.roleSwitch'], usersHostHarness, { strict: true });
});
