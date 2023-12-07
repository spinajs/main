import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
}

const fs = {
  fs: {
    defaultProvider: 'fs-local',
    providers: [
      /**
       * provide temporary fs access for s3 files
       */
      {
        service: 'fsNative',
        name: 'fs-temp-s3',
        basePath: dir('./../fs/temp-s3'),
      },
    ],
  },
};

export default fs;
