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

      // No `migrations` entry: a non-empty `system.dirs.migrations` replaces the app's default scan set. The
      // migrations carry `@Migration` and are found in the DI registry instead.
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
