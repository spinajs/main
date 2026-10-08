import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-token', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'authn-token', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const authnToken = {
  system: {
    dirs: {
      // CLI commands are found by a filesystem scan ( `@ListFromFiles` ), so
      // without this entry the shipped commands are unreachable in a consuming app.
      cli: [...dir('cli')],

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
      // the DI registry by `DiRegistryMigrationSource`. `@spinajs/users` ships
      // `cli` only for the same reason.
      //
      // Nothing in the framework reads `system.dirs.models` - models register
      // themselves through the `@Model` decorator when their file is imported.
    },
  },
  authn: {
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
       * Longest expiry a personal or service token may get. Expiry is mandatory (SR-08).
       */
      maxTtlDays: 90,

      /**
       * Expiry a client (HTTP route, CLI) proposes when the caller gives none.
       * TokenService itself never fills in an expiry.
       */
      defaultTtlDays: 30,

      /**
       * Longest expiry an agent token may get.
       */
      agentMaxTtlMinutes: 1440,

      /**
       * Fallback header checked when no `Authorization: Bearer` is present.
       */
      headerName: 'x-api-key',

      /**
       * Seconds between LastUsedAt writes for a busy token.
       */
      lastUsedUpdateInterval: 60,
    },
  },
};

export default authnToken;
