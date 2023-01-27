import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
}

const fs = {
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
