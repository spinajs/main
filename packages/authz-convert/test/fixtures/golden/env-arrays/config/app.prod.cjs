module.exports = {
  rbac: {
    impersonation: { protectedRoles: ['finance'] },
    password: { generator: { characters: ['!?'] } },
    user: { reserved: ['ops'] },
    token: { excludedRoles: ['bot'] },
    grants: { editor: { note: { 'read:any': ['*'] } } },
  },
};
