/**
 * What the 2.x packages put into every app's config (@spinajs/rbac, rbac-http-user, rbac-http-admin,
 * rbac-http-token and @spinajs/http 2.0.546). The converter reads only the app's own files, so it uses
 * these where the app's 2.x behaviour came from a package value: keys built from several 2.x keys,
 * arrays 2.x joined with the package array, grant lists 2.x joined with a package list, and roles
 * accesscontrol knew from the packages.
 */

/** Scalar defaults, keyed by the path under `rbac`. */
export const RBAC_2X_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
  'twoFactorAuth.enabled': true,
  'twoFactorAuth.service': 'Default2FaToken',
  'admin.roleGuard.privilegedResource': 'users',
  'admin.roleGuard.privilegedAction': 'update:any',
  'auth.service': 'SimpleDbAuthProvider',
  'password.blockAfterAttempts': 5,
  'password.lockoutTime': 15 * 60,
  defaultRole: 'guest',
  enableGuestAccount: false,
});

/** Arrays the configuration loader joined with the app's array (arrays concatenate), keyed by the path under `rbac`. */
export const RBAC_2X_ARRAYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'impersonation.protectedRoles': Object.freeze(['system']),
  'password.generator.characters': Object.freeze(['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789']),
});

/** The public default of @spinajs/http's http.cookie.secret. */
export const HTTP_2X_COOKIE_SECRET = '1234adreewD';

const CRUD = ['create', 'read', 'update', 'delete'];
const lists = (role: string, resource: string, actions: readonly string[], attrs: readonly string[]): [string, readonly string[]][] => actions.map((a) => [`${role}|${resource}|${a}`, attrs]);

/** `role|resource|action` → the attribute list the packages granted there; 2.x joined an app list on the same key with it. */
export const RBAC_2X_PACKAGE_GRANTS: ReadonlyMap<string, readonly string[]> = new Map([
  ...lists('guest', 'UserBase', ['read:own'], ['*']),
  ...lists('admin.users', 'users', CRUD.map((v) => `${v}:any`), ['*']),
  ...lists('admin.users', 'user.metadata', CRUD.map((v) => `${v}:any`), ['*']),
  ...lists('admin.users', 'user.tokens', CRUD.map((v) => `${v}:any`), ['*']),
  ...lists('user', 'user', ['read:own'], ['Email', 'Login']),
  ...lists('user', 'user', ['update:own'], ['Email', 'Login', 'Password']),
  ...lists('user', 'user.metadata', CRUD.map((v) => `${v}:own`), ['*']),
  ...lists('user', 'user.tokens', CRUD.map((v) => `${v}:own`), ['*']),
]);

/** `$extend` lists of the package roles; 2.x joined an app's `$extend` on the same role with them. */
export const RBAC_2X_PACKAGE_EXTENDS: Readonly<Record<string, readonly string[]>> = Object.freeze({ system: Object.freeze(['admin']), admin: Object.freeze(['admin.users']) });

/** Roles the packages defined in rbac.grants, so accesscontrol knew them in every app. */
export const RBAC_2X_PACKAGE_ROLES: ReadonlySet<string> = new Set(['guest', 'system', 'admin.users', 'user', 'admin']);
