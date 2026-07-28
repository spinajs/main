import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'rbac-http-user', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}


const rbacHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
      cli: [dir('cli')]
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
  rbac: {
    otpauth: {
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
    twoFactorAuth: {
      enabled: true,
      forceUser: false,
      service: 'Default2FaToken',
    },
    // NOTE: the session cookie ( `rbac.session.cookie` ) is configured by
    // @spinajs/rbac and defaults to Secure + SameSite=Strict + HttpOnly. This
    // package used to weaken it to SameSite=Lax here, which is what let a
    // cross-site GET reach the logout route.
    password: {
      // NOTE: the password reset token's lifetime is `rbac.password.passwordResetWaitTime`
      // ( seconds, defined by @spinajs/rbac ) — this package does not restate it.

      /**
       * Block account after invalid login attempts
       */
      blockAfterAttempts: 3,
    },
  },
  http: {
    // middlewares: [
    //   // add global user from session middleware
    // ],
  },
};

export default rbacHttp;
