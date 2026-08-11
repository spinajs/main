import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'rbac-http-token', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'rbac-http-token', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const rbacHttpToken = {
  system: {
    dirs: {
      // CLI commands and controllers are found by a filesystem scan
      // ( `@ListFromFiles` ), so without these entries the shipped commands and
      // the AccessToken controller are unreachable in a consuming app.
      cli: [...dir('cli')],
      controllers: [...dir('controllers')],

      // `migrations` is DELIBERATELY not shipped here, and neither is `models`.
      //
      // Package configs merge into an app's config by ARRAY CONCAT, and
      // `FilesystemMigrationSource` treats a non-empty `system.dirs.migrations`
      // as "the operator configured the scan set": it then REPLACES the build
      // layout defaults instead of adding to them, and turns a failed `.js`
      // import from a warning into a throw ( `orm/src/migration-sources.ts`,
      // and the docblock on `orm/src/config/orm.ts` which ships the key empty
      // for exactly this reason ). A single line here would therefore silently
      // switch off migration discovery in every application that installs this
      // package. `RbacHttpTokenInitial_...` needs no scan anyway - it carries
      // `@Migration`, is exported from the package index, and is picked up from
      // the DI registry by `DiRegistryMigrationSource`. `@spinajs/rbac` ships
      // `cli` only for the same reason.
      //
      // Nothing in the framework reads `system.dirs.models` - models register
      // themselves through the `@Model` decorator when their file is imported.
    },
  },
  queue: {
    // All events emitted by this package go to the black hole connection
    // declared by @spinajs/rbac ( `rbac-user-empty-queue` ). Without the
    // routing they would fall back to the application's DEFAULT connection -
    // a real broker - and every token operation would publish to it.
    routing: {
      AccessTokenCreated: { connection: 'rbac-user-empty-queue' },
      AccessTokenDeleted: { connection: 'rbac-user-empty-queue' },
      AccessTokenRoleGranted: { connection: 'rbac-user-empty-queue' },
      AccessTokenRoleRevoked: { connection: 'rbac-user-empty-queue' },
    },
  },
  rbac: {
    token: {
      /**
       * Token generation algorithm. Swap for your own implementation of
       * AccessTokenGenerationProvider registered under this name.
       */
      generation: {
        service: 'SecureRandomTokenProvider',
      },

      /**
       * Stable plaintext prefix - lets secret scanners recognise leaked tokens.
       */
      prefix: 'spt_',

      /**
       * Random bytes per token ( 32 = 256 bit entropy ).
       */
      length: 32,

      /**
       * Fallback header checked when no `Authorization: Bearer` is present.
       */
      headerName: 'x-api-key',

      /**
       * Seconds between LastUsedAt writes for a busy token.
       */
      lastUsedUpdateInterval: 60,
    },
    grants: {
      user: {
        'user.tokens': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
      },

      // RESERVED - nothing shipped in this package enforces or consumes these.
      //
      // `AccessTokenController` is self-service by construction: every one of
      // its routes declares an `*Own` permission and additionally constrains
      // its query by the caller's id ( `own()` ), so an `*:any` grant changes
      // nothing about what that controller lets through. The entry is here so
      // the role's grant map is complete ahead of an admin-scope controller -
      // "list / revoke the tokens of any user" is the obvious next addition -
      // and so an application that writes such a controller itself finds the
      // grants already declared under the resource name it must use.
      'admin.users': {
        'user.tokens': { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
      },
    },
  },
};

export default rbacHttpToken;
