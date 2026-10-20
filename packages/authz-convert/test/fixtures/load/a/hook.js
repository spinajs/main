export const settings = { hooked: false };
export function onConfigLoad(cfg) { return { default: { rbac: { roleColumn: 'Roles' } } }; }
