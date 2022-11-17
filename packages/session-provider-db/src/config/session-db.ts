import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

module.exports = {
  rbac: {
    session: {
      db: {
        cleanupInterval: 10 * 60 * 1000,
      },
    },
  },
};
