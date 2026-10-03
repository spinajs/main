const authnLocal = {
  authn: {
    local: {
      // `service` is left out while @spinajs/users still ships the 2.x
      // `authn.local.hasher.service: 'BasicPasswordProvider'`: package configs
      // merge in glob order, and either value would break the other package.
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
    },
  },
};

export default authnLocal;
