export default { rbac: { session: { cookie: { secure: process.env.NODE_ENV === 'production' } }, defaultRole: 'user' } };
