export default {
  authz: {
    admin: {
      guard: {
        service: 'DefaultAdminGuard',
        privilegedPermission: 'users:update',
        protectSystemRole: true,
        preventEscalation: true,
        preventSelfLockout: true,
        preventLastPrivilegedRemoval: true,
      },
    },
  },
};
