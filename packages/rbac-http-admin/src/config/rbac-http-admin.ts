import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.cwd(), 'node_modules', '@spinajs', 'rbac-http-user', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const rbacHttpAdmin = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
      locales: [dir('locales')],
      views: [dir('views')],
    },
  },
};

export default rbacHttpAdmin;