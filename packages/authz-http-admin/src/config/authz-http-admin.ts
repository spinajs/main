import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authz-http-admin', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const authzHttpAdmin = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },
};

export default authzHttpAdmin;
