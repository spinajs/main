import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authz-rbac', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'authz-rbac', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

// Only cli/commands: the Cli takes the first export of each file there, so helpers and barrels must stay out.
const rbacCli = {
  system: {
    dirs: {
      cli: [...dir('cli/commands')],
    },
  },
};

export default rbacCli;
