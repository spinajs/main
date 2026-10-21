import { join, normalize, resolve } from 'path';
import { isDevOrTestEnv } from '@spinajs/configuration';

// D3: the env as the configuration resolves it, so an app that names no env counts as development, as for `*.dev.js` files.
// Evaluated once, when the configuration first loads this file.
function appEnv(): string {
  const flag = process.argv.indexOf('--env');
  return (flag >= 0 ? process.argv[flag + 1] : undefined) ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
}

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
      jobs: [...dir('queue')],
    },
  },
  authn: {
    local: {
      // No code reads `hasher.service`: `@Injectable(PasswordHasher)` selects
      // Argon2PasswordHasher.
      hasher: {
        // `maxConcurrent` (argon2 operations at once, 64 MiB each) is not set here:
        // unset, it is UV_THREADPOOL_SIZE - 1, at least 1. Small hosts lower it, never the cost (H30).

        /** Operations that may wait for a slot; beyond it hash and verify fail with HasherBusy. */
        maxQueue: 64,
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

      /**
       * Foreign password hash formats that still verify: 'bcrypt' and/or 'pbkdf2'
       * (`$pbkdf2-sha256$<iterations>$<salt>$<hash>`). A successful login rewrites
       * the stored hash as argon2. Empty: only argon2 verifies.
       */
      legacyHashes: [] as ('bcrypt' | 'pbkdf2')[],

      // `rule`, `description` and `generator` ship no value here: the schema
      // fills the defaults, and a shipped `generator.characters` array would
      // be concatenated with the schema's by the config merge.
      policy: {
        /** Code points; both within 8–128 (A04). Login always uses 8–128. */
        minLength: 8,
        maxLength: 128,

        /**
         * Name of a registered `PasswordBlocklist` service; null: none. Outside development and test the Have I Been Pwned
         * range check (fails open after `hibp.timeoutMs`).
         */
        blocklist: (isDevOrTestEnv(appEnv()) ? null : 'HibpPasswordBlocklist') as string | null,

        /** Refuse passwords equal to, containing or within 2 edits of the login, the email local part or the name. */
        similarity: true,
      },

      hibp: {
        /** Have I Been Pwned range API; only the first 5 hex characters of the password's SHA-1 are sent. */
        url: 'https://api.pwnedpasswords.com/range/',
        /** Past it the check lets the password through and logs a warning (fails open). */
        timeoutMs: 2000,
      },

      // `expiration` ships no value here: the schema defaults are `enabled: false`, `maxAgeDays: 31`.

      reset: {
        /**
         * A reset, an admin reset and `set` also revoke every API and agent
         * token. A voluntary change never does (H32).
         */
        revokeTokens: true,
      },

      verify: {
        /** Lifetime of a verify link: a day, as a mailbox is not always read at once. */
        ttlSeconds: 86400,
        /** The page that redeems the secret; it posts `{ secret }` to POST /auth/verify. */
        url: '',
      },

      mail: {
        /**
         * 'queue': each mail is an AuthnMailJob that a queue consumer delivers; it needs a real connection for
         * `queue.routing.AuthnMailJob`. 'inline': delivered in this process after the caller has its answer.
         */
        delivery: 'queue' as 'queue' | 'inline',
      },
    },
  },
  queue: {
    routing: {
      AuthnMailJob: { connection: 'authn-mail' },
    },

    // Drops every job until an app configures its own `authn-mail` connection; outside development and test
    // `@spinajs/users` refuses to boot with it.
    connections: [
      {
        name: 'authn-mail',
        service: 'BlackHoleQueueClient',
        defaultQueueChannel: 'authn-mail-jobs',
        defaultQueueDeadLetterChannel: 'authn-mail-jobs-dlq',
      },
    ],
  },
};

export default authnLocal;
