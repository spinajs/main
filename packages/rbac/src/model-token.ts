import { DI } from '@spinajs/di';
import { User } from './models/User.js';

/** DI value-cache key holding the user model CLASS the rbac packages query with. */
export const RBAC_USER_MODEL = 'RbacUserModel';

/**
 * The user model class the application wants the rbac packages to build queries
 * with. Defaults to the shipped {@link User}. An application substitutes its own
 * subclass — typically carrying `@OrmResource('users')` and `rbac*` scoping
 * hooks, so the rbac query middleware row-scopes every admin route — with:
 *
 *   DI.register(MyUserModel).asValue(RBAC_USER_MODEL, true);
 *
 * Query enforcement keys off the class a static query was built from, which is
 * why this is a CLASS token and not another instance factory.
 */
export function userModel(): typeof User {
  return DI.get<typeof User>(RBAC_USER_MODEL) ?? User;
}
