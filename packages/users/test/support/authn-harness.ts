import { UnsupportedConfig } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HarnessContext } from '@spinajs/authn-testing';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { testHost } from '@spinajs/authz-testing';

import { ROLE_SWITCH_PASSWORD_KEY } from '../../src/index.js';
import { setIdentityFlags } from './users-db.js';
import { ConfigScope, grantGlobal, removeAccounts, resetAuthnCaseServices, rootRbacModel, seedAccount, useMfaStep, usersHttpApp } from './http-app.js';

/** Config keys a case may set: those the app reads on every use. Any other makes the factory throw UnsupportedConfig. */
export const SUPPORTED_CONFIG: readonly string[] = ['authn.freshAuth.maxAgeSeconds', 'authn.impersonation', 'authn.mfa.policy.force'];

function leafKeys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [prefix];
  return Object.entries(o).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

const leafValue = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o);

function supportedLeaves(config: ConfigOverrides): string[] {
  const leaves = leafKeys(config).filter((k) => k !== '');
  const unsupported = leaves.filter((k) => !SUPPORTED_CONFIG.some((s) => k === s || k.startsWith(`${s}.`)));
  if (unsupported.length > 0) throw new UnsupportedConfig(unsupported);
  return leaves;
}

const roleKey = (role: string) => ['authz', 'rbac', 'roles', role];
const PASSWORD_LIST = ROLE_SWITCH_PASSWORD_KEY.split('.');

/**
 * runAuthnBehaviour's factory over the users http app (http-app.ts) with registerRootRbac: users' real hooks behind
 * authn-http's routes, roles granted at GLOBAL through the root AuthzAdmin. Each case gets a fresh MFA step, fresh authn
 * services and its config keys through a ConfigScope. dispose removes the accounts the case seeded (before the config
 * undo, as the revoke reads the case's role definitions), undoes the config and drops the case's roles from the root
 * model.
 */
export async function usersAuthnHarness(ctx: HarnessContext): Promise<Harness> {
  const leaves = supportedLeaves(ctx.config);
  const scope = new ConfigScope();
  const seeded: IdentityRef[] = [];
  let definedRoles = false;
  const dispose = async () => {
    try {
      await removeAccounts(seeded.splice(0));
    } finally {
      scope.restore();
      if (definedRoles) rootRbacModel()?.invalidate(['model:rbac']);
      resetAuthnCaseServices();
    }
  };

  try {
    resetAuthnCaseServices();
    for (const path of leaves) scope.set(path.split('.'), leafValue(ctx.config, path));
    const mfa = useMfaStep();
    const app = usersHttpApp();

    return {
      http: app.httpPort(),
      seed: {
        async user(spec) {
          const ref = await seedAccount({ login: spec.login, ...(spec.email ? { email: spec.email } : {}), ...(spec.password !== undefined ? { password: spec.password } : {}) });
          seeded.push(ref);
          if (spec.status) await setIdentityFlags(ref, spec.status);
          return ref;
        },
        setStatus: (id, status) => setIdentityFlags(id, status),
      },
      roles: {
        // RbacRoleSource flags a role requirePassword when it is in the list; set the list for the case.
        async grant(id, roles) {
          const cfg = testHost.config();
          const missing = roles.filter(({ role }) => cfg.get(roleKey(role)) === undefined);
          for (const { role } of missing) scope.set(roleKey(role), {});
          if (missing.length > 0) {
            definedRoles = true;
            rootRbacModel()?.invalidate(['model:rbac']);
          }
          const listed = new Set(cfg.get<string[] | undefined>(PASSWORD_LIST) ?? []);
          for (const r of roles) if (r.requirePassword) listed.add(r.role);
          scope.set(PASSWORD_LIST, [...listed]);
          await grantGlobal(
            id,
            roles.map((r) => r.role),
          );
        },
      },
      mfa: { step: mfa, enrol: async (id) => mfa.enrol(id), code: async (id) => mfa.nextCode(id) },
      dispose,
    };
  } catch (e) {
    await dispose();
    throw e;
  }
}
