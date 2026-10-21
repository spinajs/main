import { join, normalize, resolve } from 'path';

import { CSRF_REFUSAL_LOG_FILTERS } from '../middleware/csrf-log.js';

function singleDir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const authnHttp = {
  authn: {
    http: {
      registration: {
        // Tell the owner of a taken address that someone tried to register with it.
        notifyExisting: true,
      },
      csrf: {
        // Matched against the request path after http.controllers.route.prefix.
        unauthenticatedRoutes: ['/auth/login', '/auth/password/reset-request', '/auth/password/reset', '/auth/keys/login', '/auth/mfa/verify', '/auth/mfa/recovery'],
      },
    },
  },
  system: {
    dirs: {
      // Controllers are found by a filesystem scan, not by import.
      controllers: [singleDir('v3/controllers')],
      cli: [singleDir('cli')],
    },
  },
  // Config arrays concatenate, so these join the app's own logger.filters.
  logger: {
    filters: CSRF_REFUSAL_LOG_FILTERS,
  },
};

export default authnHttp;
