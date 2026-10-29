import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'http-lazy-file-uploader', 'lib', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'http-lazy-file-uploader', 'lib', path))),
  ];
}

const config = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
  queue: {
    routing: {
      LazyUploadJob: '/queue/lazy-file-upload',
    },
  },
};

export default config;
