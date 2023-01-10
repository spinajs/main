import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

const templates = {
  system: {
    dirs: {
      templates: [dir('./../templates')],
    },
  },
};

export default templates;
