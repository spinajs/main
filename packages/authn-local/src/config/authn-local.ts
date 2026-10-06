import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-local', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'authn-local', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const authnLocal = {
  system: {
    dirs: {
      // Commands are found by a filesystem scan (`@ListFromFiles`).
      cli: [...dir('cli')],
    },
  },
  authn: {
    local: {
      // No code reads `hasher.service`: `@Injectable(PasswordHasher)` selects
      // Argon2PasswordHasher.
      hasher: {
        /**
         * Argon2 operations at once (hash and verify); the rest queue. Each
         * takes 64 MiB, so small hosts lower this, never the cost (H30).
         */
        maxConcurrent: 8,
      },

      /**
       * HMAC-SHA256 pepper applied before argon2. `secret` is a reference the
       * configuration resolves, never an inline value; null: no pepper.
       * `version` goes into the stored hash (`$sp<version>$`). To rotate, move
       * the old `{ secret, version }` to `previous`: its hashes still verify
       * and are rehashed under the new pepper on the next login.
       */
      pepper: {
        secret: null as string | null,
        version: 1,
        previous: [] as { secret: string; version: number }[],
      },

      // `rule`, `description` and `generator` ship no value here: the schema
      // fills the defaults, and a shipped `generator.characters` array would
      // be concatenated with the schema's by the config merge.
      policy: {
        /** Code points; both within 8–128 (A04). Login always uses 8–128. */
        minLength: 8,
        maxLength: 128,

        /** Name of a registered `PasswordBlocklist` service; null: none. */
        blocklist: null as string | null,
      },

      // `expiration` ships no value here: the schema defaults are `enabled: false`, `maxAgeDays: 31`.

      reset: {
        /**
         * A reset, an admin reset and `set` also revoke every API and agent
         * token. A voluntary change never does (H32).
         */
        revokeTokens: true,
      },
    },
  },
};

export default authnLocal;
