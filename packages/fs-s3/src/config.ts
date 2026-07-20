import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), path)));
}

const fs = {
  fs: {
    providers: [
      /**
       * provide temporary fs access for s3 files
       *
       * backend must stay LOCAL - fsS3 uses fs-temp-s3 to download files to local disk
       */
      {
        service: 'fsNative',
        name: 'fs-temp-s3-local',
        basePath: dir('./../fs/temp-s3'),
      },
      {
        service: 'fsTemp',
        name: 'fs-temp-s3',
        provider: 'fs-temp-s3-local',
        cleanup: true,

        // in ms
        cleanupInterval: 3600 * 1000, // clean every hour

        // in seconds
        maxFileAge: 24 * 3600, // 1 day for temp files,
      },
    ],
  },
};

export default fs;
