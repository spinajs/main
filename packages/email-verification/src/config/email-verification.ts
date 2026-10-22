import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'email-verification', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'email-verification', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

// Only the CLI scan dir: the emailVerification defaults live in the schema.
const emailVerification = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
};

export default emailVerification;
