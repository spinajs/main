import { REBAC_DEFAULT_LIMITS, REBAC_DEFAULT_STORE } from '../namespace/schema.js';

// Package config merges before the app's: an app's authz.rebac keys win.
const rebac = {
  authz: {
    rebac: {
      store: REBAC_DEFAULT_STORE,
      limit: { ...REBAC_DEFAULT_LIMITS },
      namespaces: {},
      permissions: {},
    },
  },
};

export default rebac;
