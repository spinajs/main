import '@spinajs/log';
import '@spinajs/orm-sqlite';
// Stores, their migrations and the resource middlewares must register before the Orm resolves.
import '@spinajs/authz-orm';
import '@spinajs/authz-orm/changelog';
import '@spinajs/authz-rbac';

import { randomUUID } from 'node:crypto';

import { AuthzAdminFailure, AuthzService, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Orm, OrmMigrationGuard, OrmMigrator } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';

import '../../../src/index.js';
import tenancyAuthz from '../../../src/config/tenancy-authz.js';
import './models.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

/** What an app adds to the package fragments: the stores, the admin guard and a permission on its own resource. */
export const APP_AUTHZ = {
  models: ['RbacModel'],
  // contract:read declares tenant: the admin guard counts a permission granted at a scope of an undeclared type as not held.
  permissions: { 'authz:assignments.manage': {}, 'contract:read': { types: ['contract', 'tenant'] } },
  rbac: {
    stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'] },
    roles: { 'tenant.member': { grants: ['contract:read'] } },
  },
  admin: {
    backend: 'DbAuthzAdminBackend',
    guard: { service: 'DefaultAdminGuard', privilegedPermission: 'authz:assignments.manage', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true },
  },
};

export const TENANTS = [{ id: 'acme' }, { id: 'globex' }, { id: 'initech', state: 'suspended' }];

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The configuration merge: objects deep, arrays concatenated. */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(source)) {
    const cur = out[k];
    if (Array.isArray(cur) && Array.isArray(v)) out[k] = [...cur, ...v];
    else if (isRecord(cur) && isRecord(v)) out[k] = deepMerge(cur, v);
    else out[k] = structuredClone(v);
  }
  return out;
}

export interface AuthzStack {
  readonly orm: Orm;
  readonly authz: AuthzService;
}

let booted: Promise<AuthzStack> | undefined;

/** Boots the root authz domain over one sqlite database with `authz` merged from `fragments` and the other `config` sections. */
export function bootAuthzStack(fragments: readonly Record<string, unknown>[], config: Record<string, unknown> = {}): Promise<AuthzStack> {
  return (booted ??= (async () => {
    const cfg = await testHost.installHost();
    cfg.set('logger', SILENT);
    cfg.set('db', { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }], Aliases: { authz: 'default', tenancy: 'default' }, StrictTableCheck: false });
    cfg.set('tenancy', { tenants: TENANTS });
    for (const [key, value] of Object.entries(config)) cfg.set(key, value);
    const { orm } = await migrateTestDatabase();
    await orm.reloadTableInfo();
    cfg.set('authz', fragments.reduce<Record<string, unknown>>((merged, f) => deepMerge(merged, f), {}));
    const authz = await DI.resolve<AuthzService>(AuthzService);
    return { orm, authz };
  })());
}

/** The stack of the authz bridge tests; once per mocha process. */
export function authzStack(): Promise<AuthzStack> {
  return bootAuthzStack([tenancyAuthz.authz, APP_AUTHZ]);
}

/** A user nobody else in the run shares. */
export const person = (name: string, attributes: Record<string, unknown> = {}): Principal => userPrincipal(`${name}-${randomUUID().slice(0, 8)}`, { attributes });

export async function run(commands: readonly AuthzCommand[], actor: Principal = SYSTEM): Promise<void> {
  const authz = await DI.resolve<AuthzService>(AuthzService);
  for (const r of await authz.admin().execute(actor, commands, { reason: 'test' })) {
    if (!r.ok) throw new AuthzAdminFailure(r.error.code, r.error.message, r.error.field);
  }
}

export const grant = (subject: PrincipalRef, role: string, scope: ResourceRef, actor: Principal = SYSTEM): Promise<void> =>
  run([{ kind: 'assignment.grant', subject: { type: subject.type, id: subject.id }, role, scope }], actor);

// A root hook: once, after every test file of the process.
after(async function () {
  this.timeout(60000);
  if (!booted) return;
  const { orm } = await booted;
  DI.RootContainer.uncache(Orm);
  DI.RootContainer.uncache(OrmMigrator);
  DI.RootContainer.uncache(OrmMigrationGuard);
  await orm.dispose();
  await testHost.uninstallHost();
  booted = undefined;
});
