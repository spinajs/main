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
  queue: {
    routing: {
      User2FaDisabled: { connection: 'rbac-user-empty-queue' },
      User2FaEnabled: { connection: 'rbac-user-empty-queue' },
      User2FaPassed: { connection: 'rbac-user-empty-queue' },
      User2FaReset: { connection: 'rbac-user-empty-queue' },
    },
  },
  authn: {
    mfa: {
      totp: {
        /**
         * change this to your app name, it will be used as issuer in otpauth token
         */
        issuer: 'Spinajs',

        /**
         * recommended defaults for rest
         */
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        window: 1,
      },
    },
  },
  rbac: {
    twoFactorAuth: {
      enabled: true,

      // `POST /user/2fa/reset` relies on this flag to recover an account that
      // was left password-only after a reset was abandoned before the new
      // secret was confirmed (see the docblock on `reset` in
      // TwoFactorAuthUserController) — with it `false`, as it defaults here,
      // that downgrade is silent and permanent for any consumer of this
      // package that does not override it.
      forceUser: false,
      service: 'Default2FaToken',
    },
  },
};

export default authnTotp;
