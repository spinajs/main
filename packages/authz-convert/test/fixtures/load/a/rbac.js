export default { rbac: { defaultRole: 'user', grants: { user: { $extend: ['base'] } } }, http: { cors: { origins: ['https://a.example'] } } };
