import { DI } from '@spinajs/di';
import { join, normalize, resolve } from 'path';

const isESMMode = DI.get<boolean>('__esmMode__');

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
}
const rbacHttp = {
  system: {
    dirs: {
      controllers: [dir(`node_modules/@spinajs/rbac-http/lib/${isESMMode ? 'mjs/controllers' : 'cjs/controllers'}`)],
      locales: [dir(`node_modules/@spinajs/rbac-http/lib/${isESMMode ? 'mjs/locales' : 'cjs/locales'}`)],
      views: [dir(`node_modules/@spinajs/rbac-http/lib/${isESMMode ? 'mjs/views' : 'cjs/views'}`)],
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
