import { AuthzAdminFailure, AuthzConfigError, AuthzService, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommand, Principal, PrincipalRef } from '@spinajs/authz';
import { AssignmentStore } from '@spinajs/authz-rbac';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

/** A user as an authz subject (D4: the Uuid, never the numeric Id). */
export function userRef(uuid: string): PrincipalRef {
  return { type: 'user', id: uuid };
}

export interface RoleWriteOptions {
  /** Goes to the AuthzAdmin audit. */
  readonly reason: string;
  /** The parameter a refused role is reported against. */
  readonly field: string;
  /** Default SYSTEM, which AuthzAdmin's guard does not check. */
  readonly actor?: Principal;
  readonly dryRun?: boolean;
}

/** The roles `create()` grants when the caller names none (L1-1). Absent means none. */
export const DEFAULT_ROLES_KEY = 'authz.rbac.defaultRoles';

// The AuthzAdmin codes that mean "this role cannot be held here": the caller named a bad role.
const ROLE_REFUSALS: ReadonlySet<string> = new Set(['unknown_role', 'not_assignable', 'wrong_scope_type']);

async function rootAdmin(): Promise<AuthzAdmin> {
  return ((await DI.resolve(AuthzService)) as AuthzService).admin();
}

async function assignmentStore(): Promise<AssignmentStore> {
  if (!DI.RootContainer.hasRegistered(AssignmentStore)) {
    throw new AuthzConfigError('users: no AssignmentStore is registered; register the authz-rbac stores (registerRbacStores) before reading role assignments');
  }

  return (await DI.resolve(AssignmentStore)) as AssignmentStore;
}

/**
 * Runs the commands in one AuthzAdmin batch. A refused role becomes `InvalidArgument` (error code =
 * the AuthzAdmin code) so HTTP callers keep answering 400; any other failure is thrown as the
 * `AuthzAdminFailure` it is.
 */
async function execute(commands: AuthzCommand[], opts: RoleWriteOptions): Promise<void> {
  if (commands.length === 0) {
    return;
  }

  const results = await (await rootAdmin()).execute(opts.actor ?? SYSTEM, commands, { reason: opts.reason, dryRun: opts.dryRun === true });

  for (const r of results) {
    if (r.ok) {
      continue;
    }

    const failure = new AuthzAdminFailure(r.error.code, r.error.message, r.error.field);
    if (ROLE_REFUSALS.has(r.error.code)) {
      throw new InvalidArgument(`Role refused: ${r.error.message}`, opts.field, r.error.code, failure);
    }
    throw failure;
  }
}

/**
 * Grants each role to `user:<uuid>` at GLOBAL. With `dryRun` the batch is validated and guarded,
 * then rolled back: callers use it to refuse a bad role before they write anything themselves.
 */
export async function assignGlobalRoles(uuid: string, roles: readonly string[], opts: RoleWriteOptions): Promise<void> {
  const subject = userRef(uuid);
  await execute(
    roles.map((role): AuthzCommand => ({ kind: 'assignment.grant', subject, role, scope: GLOBAL })),
    opts,
  );
}

/** Uuids of the users that hold any of `roles` at GLOBAL now; subject sets are not expanded. */
export async function globalRoleHolders(roles: readonly string[]): Promise<string[]> {
  const store = await assignmentStore();
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
