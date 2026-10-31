module.exports = {
  rbac: {
    impersonation: { protectedRoles: ['auditor'] },
    password: { generator: { characters: ['0123'] } },
    user: { reserved: ['root'] },
    token: { excludedRoles: ['agent'] },
    roles: [{ Name: 'editor' }],
    grants: { editor: { doc: { 'read:any': ['*'] } } },
  },
};
