import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'scheduler-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const schedulerHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },
  scheduler: {
    http: {
      sse: {
        /**
         * ms between `: ping` comments on open event streams, keeps proxies from closing idle streams
         */
        heartbeat: 15000,
      },
    },
  },
  rbac: {
    grants: {
      'admin.scheduler': {
        scheduler: {
          'read:any': ['*'],
          'update:any': ['*'],
          'delete:any': ['*'],
        },
      },
      admin: {
        $extend: ['admin.scheduler'],
      },
    },
  },
};

export default schedulerHttp;
