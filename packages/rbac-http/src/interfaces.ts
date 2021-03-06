import { User, ISession } from '@spinajs/rbac';

export type PermissionType = 'readAny' | 'readOwn' | 'updateAny' | 'updateOwn' | 'deleteAny' | 'deleteOwn' | 'createAny' | 'createOwn';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    user: User | null;
    session: ISession;
  }
}

export interface IRbacDescriptor {
  /**
   * Resource name
   */
  Resource: string;

  /**
   * Assigned permission
   *
   * '*' means that to acces resource we only need role with assigned resource
   */
  Permission: PermissionType;

  /**
   * Per routes permissions
   */
  Routes: Map<string, IRbacRoutePermissionDescriptor>;
}

export interface IRbacRoutePermissionDescriptor {
  /**
   * controller route permission. It overrides acl descriptor options
   */
  Permission: PermissionType;
}
