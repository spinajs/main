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

      // system fs
      // paths without basepath set
      // using this filesystem 
      // all paths are relative to process path
      // or absulute path must be provided
      {
        service: 'fsNative',
        name: 'fs-system',
      },
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
