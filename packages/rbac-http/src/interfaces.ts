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

export abstract class TwoFactorAuthProvider {
  /**
   * generate secret key if this provider use is needs it or null
   */
  public abstract initialize(user: User): Promise<any | null>;

  /**
   * Perform action eg. send sms or email. Some 2fac implementations do nothing eg. google auth or hardware keys
   */
  public abstract execute(user: User): Promise<void>;

  /**
   * verifies token send by user
   */
  public abstract verifyToken(token: string, user: User): Promise<boolean>;

  /**
   * Checks if 2fa is enabled for given user
   */
  public abstract isEnabled(user: User): Promise<boolean>;

  /**
   * Checks if 2fa is initialized eg. some
   * 2fa systems requires to generate private software key and pass it
   * to user ( like google authenticator)
   */
  public abstract isInitialized(user: User): Promise<boolean>;
}

export abstract class FingerprintProvider {}

export interface AuthProvider {}

export interface TwoFactorAuthConfig {
  enabled: boolean;
  service: string;
}

export interface FingerpringConfig {
  enabled: boolean;
  maxDevices: number;
  service: string;
}
