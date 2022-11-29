import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}
module.exports = {
  system: {
    dirs: {
      controllers: [dir('./../controllers')],
      locales: [dir('./../locales')],
      views: [dir('./../views')],
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
    password_reset: {
      // password reset token ttl in minutes
      tokentTTL: 60,
    },
  },
  http: {
    middlewares: [
      // add global user from session middleware
    ],
  },
};
