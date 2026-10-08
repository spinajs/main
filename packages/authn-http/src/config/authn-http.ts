import { join, normalize, resolve } from 'path';

function singleDir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const authnHttp = {
  system: {
    dirs: {
      // Controllers are found by a filesystem scan, not by import.
      controllers: [singleDir('v3/controllers')],
      cli: [singleDir('cli')],
    },
  },
};

export default authnHttp;
