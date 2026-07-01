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
       * Dedicated role that grants full management over configuration entries.
       * Extend this role ( or `admin` below ) to give an account access to the
       * configuration HTTP api.
       */
      configuration: {
        configuration: {
          'read:any': ['*'],
          'update:any': ['*'],
        },
      },

      /**
       * Admin inherits configuration management. Merge strategy concatenates
       * `$extend` arrays so this does not overwrite existing admin grants.
       */
      admin: {
        $extend: ['configuration'],
      },
    },
  },
};

export default configurationHttp;
