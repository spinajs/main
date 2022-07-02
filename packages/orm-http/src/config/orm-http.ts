import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

module.exports = {
  system: {
    dirs: {
      controllers: [dir('./../controllers')],
      schemas: [dir('./../schemas')],
    },
  },
};
