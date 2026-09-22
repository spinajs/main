import { DI } from '@spinajs/di';
import type { User } from '@spinajs/rbac';

/**
 * Adds application fields to every auth response that reports the session's active role:
 * login, 2FA verification, whoami, both `/auth/active-role` operations and impersonation.
 * The framework knows nothing about the fields themselves - an application registers a
 * provider with `@Injectable(SessionContextProvider)` and its fields ride along.
 *
 * `resolve` gets the role the response reports, so a value derived from it follows a role
 * switch without the client asking again.
 */
export abstract class SessionContextProvider {
  /**
   * JSON-schema properties of the fields `resolve` returns, merged into the published auth
   * response schemas. Static so the spec is built without instantiating the provider.
   */
  public static Properties: Record<string, object> = {};

  public abstract resolve(user: User, activeRole: string | undefined): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/** Schema properties contributed by every registered provider. */
export function sessionContextProperties(): Record<string, object> {
  const types = (DI.getRegisteredTypes(SessionContextProvider) ?? []) as unknown as Array<typeof SessionContextProvider>;
  return Object.assign({}, ...types.map((type) => type.Properties));
}

/** Fields every registered provider adds for `user` acting as `activeRole`. */
export async function resolveSessionContext(user: User, activeRole: string | undefined): Promise<Record<string, unknown>> {
  const providers = await DI.resolve(Array.ofType(SessionContextProvider));
  const parts = await Promise.all(providers.map((provider) => provider.resolve(user, activeRole)));
  return Object.assign({}, ...parts);
}
