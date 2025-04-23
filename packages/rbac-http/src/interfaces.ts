import { User, ISession, PermissionType } from '@spinajs/rbac';


declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    User: User | null;
    Session: ISession;
    
    /**
     * Controller route permission context 
     * To check if we run from (read|update|insert|delete)Own or (read|update|insert|delete)Any scope
     * 
     * eg. we want to read only current user data but it has admin privlidges too....
     */
    PermissionScope? : PermissionType;
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
  Permission: PermissionType[];

  /**
   * Per routes permissions
   */
  Routes: Map<string, IRbacRoutePermissionDescriptor>;
}

export interface IRbacRoutePermissionDescriptor {
  /**
   * controller route permission. It overrides acl descriptor options
   */
  Permission: PermissionType[];
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

export interface TwoFactorAuthConfig {
  enabled: boolean;
  service: string;
}

export interface FingerpringConfig {
  enabled: boolean;
  maxDevices: number;
  service: string;
}
