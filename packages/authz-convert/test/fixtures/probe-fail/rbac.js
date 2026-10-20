if (process.env.NODE_ENV === 'production' && !process.env.APP_SECRET_FOR_TEST) throw new Error('APP_SECRET_FOR_TEST is not set');

export default { rbac: { defaultRole: 'user' } };
