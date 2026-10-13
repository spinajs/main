import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-totp', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const authnTotp = {
  system: {
    dirs: {
      cli: [dir('cli')],
    },
  },
  authn: {
    mfa: {
      /**
       * TOTP is off until the app turns it on (README, "Turning TOTP on"): add `{ name: 'totp', service: 'TotpMfaStep' }`
       * to its own `authn.mfa.steps` (arrays concatenate across config files, so this package lists no step), set
       * `authn.mfa.encryptionKey.secret` (the AES-256-GCM key: 32 bytes as 64 hex chars or base64/base64url; on
       * rotation move the old key to `authn.mfa.encryptionKey.previous`) and import `@spinajs/authn-totp/db`.
       *
       * No `encryptionKey` default here: every app loads this file, and a null secret would stand in for one the app
       * never set.
       */
      totp: {
        /**
         * change this to your app name, it will be used as issuer in otpauth token
         */
        issuer: 'SpinaJS',

        /**
         * recommended defaults for rest
         */
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        window: 1,
        recoveryCodes: 10,
      },
    },
  },
};

export default authnTotp;
