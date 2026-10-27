import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'email-verification', 'lib', path))),
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'email-verification', 'lib', path))),
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
