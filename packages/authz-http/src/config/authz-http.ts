import { existsSync } from 'fs';
import { join, normalize, resolve } from 'path';

export function dirWithParent(path: string, root = process.env.WORKSPACE_ROOT_PATH ?? process.cwd()) {
  const inCommonJs = typeof module !== 'undefined';
  const dir = resolve(normalize(join(root, 'node_modules', '@spinajs', 'authz-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
  // one up when the app runs from its build folder; a missing guess would warn on every boot
  const parent = resolve(normalize(join(root, '../', 'node_modules', '@spinajs', 'authz-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
  return existsSync(parent) ? [dir, parent] : [dir];
}

const authzHttp = {
  system: {
    dirs: {
      controllers: dirWithParent('controllers'),
    },
  },
};

export default authzHttp;
