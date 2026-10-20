import { join, normalize, resolve } from 'path';

function dirWithParent(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  const root = process.env.WORKSPACE_ROOT_PATH ?? process.cwd();
  return [
    resolve(normalize(join(root, 'node_modules', '@spinajs', 'authz-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
    // one up when the app runs from its build folder
    resolve(normalize(join(root, '../', 'node_modules', '@spinajs', 'authz-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const authzHttp = {
  system: {
    dirs: {
      controllers: dirWithParent('controllers'),
    },
  },
};

export default authzHttp;
