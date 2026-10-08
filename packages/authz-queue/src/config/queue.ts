// Every user holds job:read on the jobs they emitted; the `initiator` relation is JobInitiatorScope.
export default {
  authz: {
    rbac: {
      roles: {
        user: {
          grants: [{ permission: 'job:read', relation: 'initiator' }],
        },
      },
    },
  },
};
