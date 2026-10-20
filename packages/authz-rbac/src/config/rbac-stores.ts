// Store names are not here: their defaults live in code (RBAC_STORE_DEFAULTS), so a fragment merge
// can neither repeat nor shadow them.
const rbacStores = {
  authz: {
    rbac: {
      cache: {
        assignmentsTtlSeconds: 60,
      },
    },
  },
};

export default rbacStores;
