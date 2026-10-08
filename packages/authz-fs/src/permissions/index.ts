import type { PermissionDef } from '@spinajs/authz';

import { FS_RESOURCE_TYPES } from '../refs/index.js';

const fsPermission = (action: string, description: string, implies?: readonly string[]): Omit<PermissionDef, 'source'> => Object.freeze({ name: `fs:${action}`, resource: 'fs', action, types: FS_RESOURCE_TYPES, ...(implies ? { implies: Object.freeze([...implies]) } : {}), description });

export const FS_PERMISSIONS: readonly Omit<PermissionDef, 'source'>[] = Object.freeze([fsPermission('read', "Read a file's content", ['fs:stat']), fsPermission('stat', 'Check that a path exists and read its stats'), fsPermission('list', 'List the entries of a directory'), fsPermission('write', 'Create or change files and directories', ['fs:stat']), fsPermission('delete', 'Delete files and directories'), fsPermission('share', 'Create a signed URL for a file')]);
