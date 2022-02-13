import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

const configurationDbSource = {
  system: {
    dirs: {
      schemas: [dir('./../schemas')],
      models: [dir('./../models')],
    },
  },
};

export default configurationDbSource;
