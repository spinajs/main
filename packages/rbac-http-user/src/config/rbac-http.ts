import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.cwd(), 'node_modules', '@spinajs', 'rbac-http-user', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}


const rbacHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
      cli: [dir('cli')]
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
    fingerprint: {
      enabled: false,
      maxDevices: 3,
      service: 'FingerprintJs',
    },
    session:{ 
      cookie: { 
        sameSite: 'lax'
      }
    },
    password: {
      // password reset token ttl in minutes
      tokenTTL: 60,

      /**
       * Block account after invalid login attempts
       */
      blockAfterAttempts: 3,
    },
    /**
     * Should federated login be enabled ? eg. facebook
     */
    allowFederated: false,
  },
  http: {
    // middlewares: [
    //   // add global user from session middleware
    // ],
  },
};

export default rbacHttp;
