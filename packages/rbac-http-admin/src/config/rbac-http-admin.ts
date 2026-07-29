import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'rbac-http-admin', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const rbacHttpAdmin = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
      locales: [dir('locales')],
      views: [dir('views')],
    },
  },

  rbac: {
    admin: {
      /**
       * Guards applied to every admin operation that changes what an account may
       * do. Defaults are the strict end — see IRoleGuardConfig for what each one
       * refuses and why. Turn individual checks off here rather than replacing
       * the service.
       */
      roleGuard: {
        service: 'DefaultRoleGuard',

        requireKnownRole: true,
        protectSystemRole: true,
        preventEscalation: true,
        preventSelfLockout: true,
        preventLastPrivilegedRemoval: true,

        /**
         * What makes a role "privileged" for the self-lockout and last-holder
         * checks. Action uses accesscontrol grant notation, exactly as written
         * in `rbac.grants`.
         */
        privilegedResource: 'users',
        privilegedAction: 'update:any',
      },
    },
  },
};

export default rbacHttpAdmin;
