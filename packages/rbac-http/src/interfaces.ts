export interface IAclDescriptor {
  /**
   * Resource name
   */
  Resource: string;

  /**
   * Assigned permission
   *
   * '*' means that to acces resource we only need role with assigned resource
   */
  Permission: 'readAny' | 'readOwn' | 'updateAny' | 'updateOwn' | 'deleteAny' | 'deleteOwn' | 'createAny' | 'createOwn';

  /**
   * Per routes permissions
   */
  Routes: Map<string, IAclRoutePermissionDescriptor>;
}

export interface IAclRoutePermissionDescriptor {
  /**
   * controller route permission. It overrides acl descriptor options
   */
  Permission: string;
}
