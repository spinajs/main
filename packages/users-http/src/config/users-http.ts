import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'users-http', 'lib', path)));
}

const usersHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers'), dir('admin/controllers')],
    },
  },
  authz: {
    // The admin record routes; read and update carry field sets so a grant can narrow them.
    permissions: {
      'users:read': { fields: true },
      'users:create': {},
      'users:update': { fields: true },
      'users:delete': {},
    },
  },
};

export default usersHttp;
