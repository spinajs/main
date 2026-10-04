import { AuthzAdminFailure, AuthzConfigError, AuthzService, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzAdmin, AuthzAdminOptions, AuthzCommand, PrincipalRef } from '@spinajs/authz';
import { AssignmentStore } from '@spinajs/authz-rbac';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

/** A user as an authz subject (D4: the Uuid, never the numeric Id). */
export function userRef(uuid: string): PrincipalRef {
  return { type: 'user', id: uuid };
}

// The AuthzAdmin codes that mean "this role cannot be held here": the caller named a bad role.
const ROLE_REFUSALS: ReadonlySet<string> = new Set(['unknown_role', 'not_assignable', 'wrong_scope_type']);

async function rootAdmin(): Promise<AuthzAdmin> {
  return ((await DI.resolve(AuthzService)) as AuthzService).admin();
}

/**
 * Runs the commands as SYSTEM in one AuthzAdmin batch. A refused role becomes `InvalidArgument`
 * (field `roles`, error code = the AuthzAdmin code) so HTTP callers keep answering 400; any other
 * failure is thrown as the `AuthzAdminFailure` it is.
 */
async function execute(commands: AuthzCommand[], opts: AuthzAdminOptions): Promise<void> {
  if (commands.length === 0) {
    return;
  }

  const results = await (await rootAdmin()).execute(SYSTEM, commands, opts);

  for (const r of results) {
    if (r.ok) {
      continue;
    }

    const failure = new AuthzAdminFailure(r.error.code, r.error.message, r.error.field);
    if (ROLE_REFUSALS.has(r.error.code)) {
      throw new InvalidArgument(`Role refused: ${r.error.message}`, 'roles', r.error.code, failure);
    }
    throw failure;
  }
}

/**
 * Grants each role to `user:<uuid>` at GLOBAL. With `dryRun` the batch is validated and guarded,
 * then rolled back: callers use it to refuse a bad role before they write anything themselves.
 */
export async function assignGlobalRoles(uuid: string, roles: readonly string[], reason: string, dryRun = false): Promise<void> {
  const subject = userRef(uuid);
  await execute(
    roles.map((role): AuthzCommand => ({ kind: 'assignment.grant', subject, role, scope: GLOBAL })),
    { reason, dryRun },
  );
}

export async function revokeGlobalRole(uuid: string, role: string, reason: string): Promise<void> {
  await execute([{ kind: 'assignment.revokeWhere', scope: GLOBAL, subject: userRef(uuid), role }], { reason });
}

/** Uuids of the users that hold any of `roles` at GLOBAL now; subject sets are not expanded. */
export async function globalRoleHolders(roles: readonly string[]): Promise<string[]> {
  if (!DI.RootContainer.hasRegistered(AssignmentStore)) {
    throw new AuthzConfigError('users: no AssignmentStore is registered; register the authz-rbac stores (registerRbacStores) before reading role holders');
  }

  const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
  const now = new Date();
  const uuids = new Set<string>();

  for (const role of roles) {
    for (const subject of await store.holders(role, GLOBAL, now)) {
      if (!('set' in subject) && subject.type === 'user') {
        uuids.add(subject.id);
      }
    }
  }

  return [...uuids];
}
