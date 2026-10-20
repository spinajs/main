// The guard switches default in AUTHZ_CONFIGURATION_SCHEMA (@spinajs/authz).
export default {
  authz: {
    admin: {
      guard: {
        service: 'DefaultAdminGuard',
        privilegedPermission: 'users:update',
      },
    },
  },
};
