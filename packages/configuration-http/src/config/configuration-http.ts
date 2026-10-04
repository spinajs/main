import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(
    normalize(
      join(
        process.env.WORKSPACE_ROOT_PATH ?? process.cwd(),
        'node_modules',
        '@spinajs',
        'configuration-http',
        'lib',
        inCommonJs ? 'cjs' : 'mjs',
        path,
      ),
    ),
  );
}

const configurationHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },
  authz: {
    // Config values can hold secrets: both permissions carry field sets, so a grant can hide `Value`.
    permissions: {
      'configuration:read': { fields: true },
      'configuration:update': { fields: true },
    },
    rbac: {
      roles: {
        'admin.configuration': {
          assignable: false,
          grants: ['configuration:read', 'configuration:update'],
        },
        // The config merge concatenates `extends` arrays, so this adds to the other `admin` fragments.
        admin: {
          extends: ['admin.configuration'],
        },
      },
    },
  },
};

export default configurationHttp;
