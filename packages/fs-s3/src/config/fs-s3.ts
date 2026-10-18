import os from 'os';
import { join } from 'path';

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
        basePath: join(os.tmpdir(), 'spinajs-fs-temp-s3'),
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
