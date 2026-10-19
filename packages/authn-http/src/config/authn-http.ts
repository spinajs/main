import { join, normalize, resolve } from 'path';

import { CSRF_REFUSAL_LOG_FILTERS } from '../middleware/csrf-log.js';

function singleDir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const authnHttp = {
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
