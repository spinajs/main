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
      enabled: true,
      maxDevices: 3,
      service: 'FingerprintJs',
    },
  },
  http: {
    middlewares: [
      // add global user from session middleware
    ],
  },
};
