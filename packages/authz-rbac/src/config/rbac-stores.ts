// Store names and the users.Role migration columns are not here: their defaults live in code
// (RBAC_STORE_DEFAULTS, the migrations), so a fragment merge can neither repeat nor shadow them.
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
