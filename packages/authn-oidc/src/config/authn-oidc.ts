import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-oidc', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const authnOidc = {
  system: {
    dirs: {
      // Controllers are found by a filesystem scan, not by import.
      controllers: [dir('controllers')],
    },
  },
};

export default authnOidc;
