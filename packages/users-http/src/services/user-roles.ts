import { randomUUID } from 'node:crypto';
import { AuthzAdminFailure, AuthzService, GLOBAL } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommand, Principal } from '@spinajs/authz';
import { AssignmentStore, RoleStore } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

import { refusalOf } from './actor.js';

const userSubject = (uuid: string) => ({ type: 'user', id: uuid });

async function rootAdmin(): Promise<AuthzAdmin> {
  return ((await DI.resolve(AuthzService)) as AuthzService).admin();
}

/** The roles `user:<uuid>` holds now at GLOBAL, from its own assignments (subject sets are not expanded). */
export async function globalRolesOf(uuid: string): Promise<string[]> {
  const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
  const rows = await store.forSubjects([userSubject(uuid)], new Date());

  return [...new Set(rows.filter((a) => a.scope.type === GLOBAL.type).map((a) => a.role))];
}

/** The AuthzAdmin batch that turns `current` into `next`: a grant per added role, a revoke per removed one. */
export function replacementCommands(uuid: string, current: readonly string[], next: readonly string[]): AuthzCommand[] {
  const subject = userSubject(uuid);

  return [
    ...next.filter((r) => !current.includes(r)).map((role): AuthzCommand => ({ kind: 'assignment.grant', subject, role, scope: GLOBAL })),
    ...current.filter((r) => !next.includes(r)).map((role): AuthzCommand => ({ kind: 'assignment.revokeWhere', scope: GLOBAL, subject, role })),
  ];
}

/**
 * Runs the commands as one AuthzAdmin batch for `actor`; the first refusal is thrown as its HTTP exception
 * (see {@link refusalOf}), any other failure as the `AuthzAdminFailure` it is.
 */
export async function executeAsActor(actor: Principal, commands: readonly AuthzCommand[], opts: { reason: string; dryRun?: boolean }): Promise<void> {
  if (commands.length === 0) {
    return;
  }

  const results = await (await rootAdmin()).execute(actor, commands, { reason: opts.reason, dryRun: opts.dryRun === true });

  for (const r of results) {
    if (!r.ok) {
      throw refusalOf(r.error) ?? new AuthzAdminFailure(r.error.code, r.error.message, r.error.field);
    }
  }
}

/** Names of the configured roles that may be assigned at all (`assignable` is not false). */
async function assignableDefinitions(): Promise<string[]> {
  if (DI.RootContainer.hasRegistered(RoleStore)) {
    const { roles } = await ((await DI.resolve(RoleStore)) as RoleStore).load();
    return roles.filter((r) => r.assignable !== false).map((r) => r.name);
  }

  const configured = DI.get(Configuration)?.get<Record<string, { assignable?: boolean }>>('authz.rbac.roles', {}) ?? {};
  return Object.entries(configured)
    .filter(([, def]) => def?.assignable !== false)
    .map(([name]) => name);
}

/** The roles `actor` may grant at GLOBAL: those whose dry-run grant AuthzAdmin accepts. */
export async function assignableRoles(actor: Principal): Promise<string[]> {
  const admin = await rootAdmin();
  // Any subject will do; a dry run writes nothing.
  const subject = userSubject(randomUUID());
  const allowed: string[] = [];

  for (const role of await assignableDefinitions()) {
    const [result] = await admin.execute(actor, [{ kind: 'assignment.grant', subject, role, scope: GLOBAL }], { reason: 'users-http:assignable-roles', dryRun: true });
    if (result?.ok) {
      allowed.push(role);
    }
  }

  return allowed;
}
