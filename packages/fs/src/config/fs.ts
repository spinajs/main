import { join, normalize, resolve } from 'path';

function pDir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(
    normalize(join(process.cwd(), 'node_modules', '@spinajs', 'fs', 'lib', inCommonJs ? 'cjs' : 'mjs', path)),
  );
}

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
}

const fs = {
  system: {
    dirs: {
      cli: [pDir('./cli')],
    },
  },
  fs: {
    defaultProvider: 'fs-local',
    providers: [
      {
        service: 'fsNative',
        name: 'fs-local',
        basePath: dir('./../fs/files'),
      },
      /**
       * provide temporary fs access
       */
      {
        service: 'fsNative',
        name: 'fs-temp',
        basePath: dir('./../fs/temp'),
      },
    ],
  },
};

export default fs;
