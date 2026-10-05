import { AuthzAdminFailure } from '@spinajs/authz';
import type { AuthzAdminError, Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { Forbidden, InvalidArgument } from '@spinajs/exceptions';
import { User, UserPrincipalFactory } from '@spinajs/users';

/**
 * The principal the admin routes act as: the caller of the 2.x session. Without a caller the route refuses,
 * it never falls back to SYSTEM (which AuthzAdmin's guard does not check).
 */
export async function actorPrincipal(user: User | null | undefined): Promise<Principal> {
  if (!user) {
    throw new Forbidden('No authenticated caller');
  }

  const factory = (await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory;
  return factory.principalOf(user);
}

/** The AdminGuard refusals: the caller may not make this change. */
const FORBIDDEN_CODES: ReadonlySet<string> = new Set(['escalation', 'protected_role', 'forbidden', 'self_lockout', 'last_holder']);

/** The caller named a role that cannot be held there. */
const INVALID_CODES: ReadonlySet<string> = new Set(['unknown_role', 'not_assignable', 'wrong_scope_type']);

/** The HTTP exception for an AuthzAdmin refusal, or undefined when the code is not one the routes answer. */
export function refusalOf(error: AuthzAdminError, field = 'Role'): Error | undefined {
  const cause = new AuthzAdminFailure(error.code, error.message, error.field);

  if (FORBIDDEN_CODES.has(error.code)) {
    return new Forbidden(error.message, cause);
  }

  if (INVALID_CODES.has(error.code)) {
    return new InvalidArgument(`Role refused: ${error.message}`, field, error.code, cause);
  }

  return undefined;
}

/** Runs `work`, turning a thrown AuthzAdmin refusal into its HTTP exception; anything else is rethrown. */
export async function asHttpRefusal<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AuthzAdminFailure) {
      throw refusalOf(err, err.field) ?? err;
    }
    throw err;
  }
}
