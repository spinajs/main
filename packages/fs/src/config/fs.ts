import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return [
    // installed as a dependency
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'fs', 'lib', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'fs', 'lib', path))),
  ];
}

const fs = {
  system: {
    dirs: {
      // register fs cli commands so they are discovered by @spinajs/cli
      cli: [...dir('cli')],
    },
  },
};

export default fs;
