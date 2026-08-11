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
      // CLI commands, controllers and migrations are found by a filesystem scan
      // ( `@ListFromFiles` ), so without these entries the shipped commands,
      // the AccessToken controller and the initial migration are unreachable in
      // a consuming app.
      cli: [...dir('cli')],
      controllers: [...dir('controllers')],
      migrations: [...dir('migrations')],
      models: [...dir('models')],
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
      'admin.users': {
        'user.tokens': { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
      },
    },
  },
};

export default rbacHttpToken;
