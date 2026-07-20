import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'configuration-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const configurationHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },
  rbac: {
    grants: {
      /**
       * Dedicated admin sub-role granting full management over configuration
       * entries. Mirrors the `admin.users` sub-role in @spinajs/rbac: only the
       * `admin` role ( and `system`, which extends admin ) inherits it below, so
       * the configuration HTTP api is an admin-only capability. The resource
       * itself is named `configuration` ( see @Resource in the controller ).
       */
      'admin.configuration': {
        configuration: {
          'read:any': ['*'],
          'update:any': ['*'],
        },
      },

      /**
       * Admin inherits configuration management. The config merge concatenates
       * `$extend` arrays, so this is additive - it does not overwrite the base
       * admin grants ( eg. `admin.users` ).
       */
      admin: {
        $extend: ['admin.configuration'],
      },
    },
  },
};

export default configurationHttp;
