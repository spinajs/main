import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'teams-http', 'lib', path)));
}

const teamsHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },
};

export default teamsHttp;
