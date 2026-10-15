import { PermissionType } from '@spinajs/rbac';
import { SCHEDULER_RBAC } from '@spinajs/scheduler';

export const SCHEDULER_RESOURCE = SCHEDULER_RBAC.resource;

export const SCHEDULER_READ: PermissionType[] = [SCHEDULER_RBAC.read];
export const SCHEDULER_RUN: PermissionType[] = [SCHEDULER_RBAC.run];
export const SCHEDULER_MANAGE: PermissionType[] = [SCHEDULER_RBAC.manage];
