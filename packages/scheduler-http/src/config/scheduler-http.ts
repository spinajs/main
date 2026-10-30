import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'scheduler-http', 'lib', path)));
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
  authz: {
    permissions: {
      'scheduler:read': { description: 'List schedules, runs and error groups, and follow their live events' },
      'scheduler:run': { description: 'Run a schedule now, cancel and retry runs' },
      'scheduler:manage': { description: 'Pause and resume schedules, change the status of error groups, prune' },
    },
    // Unread unless the app loads @spinajs/authz-rbac.
    rbac: {
      roles: {
        'admin.scheduler': {
          assignable: false,
          grants: ['scheduler:read', 'scheduler:run', 'scheduler:manage'],
        },
        // The config merge concatenates `extends` arrays, so this adds to the other `admin` fragments.
        admin: {
          extends: ['admin.scheduler'],
        },
      },
    },
  },
};

export default schedulerHttp;
