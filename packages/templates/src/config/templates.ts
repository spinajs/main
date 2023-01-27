import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
}

const templates = {
  system: {
    dirs: {
      templates: [dir('./../templates')],
      cli: [dir('./../cli')],
    },
  },
};

export default templates;
