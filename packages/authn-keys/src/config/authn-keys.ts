import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-keys', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'authn-keys', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

// Only the CLI scan dir. A non-empty system.dirs.migrations would replace the orm's defaults in every app (see
// authn-token's config); the migration and the models register through their decorators. The authn.keys defaults
// live in the authn schema.
const authnKeys = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
};

export default authnKeys;
