import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
}

const fs = {
  fs: {
    providers: [
      /**
       * provide temporary fs access for s3 files
       */
      {
        service: 'fsNativeTemp',
        name: 'fs-temp-s3',
        basePath: dir('./../fs/temp-s3'),
        
        // in ms
        cleanupInterval: 3600 * 1000, // clean every hour

        // in seconds
        maxFileAge: 24 * 3600, // 1 day for temp files
      },
    ],
  },
};

export default fs;
