import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'users-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const usersHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers'), dir('admin/controllers')],
      locales: [dir('locales')],
      views: [dir('views')],
    },
  },
};

export default usersHttp;
