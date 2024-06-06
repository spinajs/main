import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.cwd(), 'node_modules', '@spinajs', 'rbac-http-user', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}


const rbacHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
      locales: [dir('locales')],
      views: [dir('views')],
    },
  },
  rbac: {
    twoFactorAuth: {
      enabled: true,
      service: 'SpeakEasy2FaToken',
    },
    fingerprint: {
      enabled: false,
      maxDevices: 3,
      service: 'FingerprintJs',
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
