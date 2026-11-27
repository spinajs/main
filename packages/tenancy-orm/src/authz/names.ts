import type { ResourceRef } from '@spinajs/authz';

export const TENANT_TYPE = 'tenant';

export const TENANT_ENTER = 'tenant:enter';
export const TENANT_MEMBERS_ADD = 'tenant:members.add';
export const TENANT_MEMBERS_REMOVE = 'tenant:members.remove';
export const TENANT_SETTINGS_MANAGE = 'tenant:settings.manage';

export const TENANT_MEMBER_ROLE = 'tenant.member';
export const TENANT_ADMIN_ROLE = 'tenant.admin';
export const TENANT_OWNER_ROLE = 'tenant.owner';

export const tenantResource = (id: string): ResourceRef => Object.freeze({ type: TENANT_TYPE, id });
