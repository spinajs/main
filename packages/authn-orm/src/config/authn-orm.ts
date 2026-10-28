import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-orm', 'lib', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'authn-orm', 'lib', path))),
  ];
}

const authnOrm = {
  system: {
    dirs: {
      // CLI commands are found by a filesystem scan, so without this entry `authn:audit-purge` is unreachable in a consuming app.
      cli: [...dir('cli')],
    },
  },
};

export default authnOrm;
