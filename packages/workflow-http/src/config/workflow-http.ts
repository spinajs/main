import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'workflow-http', 'lib', path)));
}

const workflowHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },
  authz: {
    permissions: {
      'workflow:read': { description: 'List and inspect workflow instances, without their input, result and error details' },
      'workflow:read-payload': { description: 'Read the input, the result and the full errors of a workflow instance' },
      'workflow:signal': { description: 'Send signals to workflow instances' },
      'workflow:manage': { description: 'Start, cancel and retry workflow instances' },
    },
    // Unread unless the app loads @spinajs/authz-rbac.
    rbac: {
      roles: {
        'admin.workflow': {
          assignable: false,
          grants: ['workflow:read', 'workflow:read-payload', 'workflow:signal', 'workflow:manage'],
        },
        // The config merge concatenates `extends` arrays, so this adds to the other `admin` fragments.
        admin: {
          extends: ['admin.workflow'],
        },
      },
    },
  },
};

export default workflowHttp;
