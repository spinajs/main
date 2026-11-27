import { join, normalize, resolve } from 'path';

function dir(path: string): string[] {
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'tenancy-orm', 'lib', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'tenancy-orm', 'lib', path))),
  ];
}

// Only cli/commands: the Cli takes the first export of each file there, so helpers must stay out.
const tenancyOrmCli = {
  system: {
    dirs: {
      cli: [...dir('cli/commands')],
    },
  },
};

export default tenancyOrmCli;
