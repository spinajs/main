import { User, ISession, PermissionType } from '@spinajs/rbac';

// ---------------------------------------------------------------------------
// HTTP response shape interfaces
// Shared across rbac-http-user and rbac-http-admin — both depend on rbac-http.
// ---------------------------------------------------------------------------

/** Single user metadata key-value entry */
export interface IUserMetadataEntry {
  Id: number;
  Key: string;
  Value: string;
  Type: 'number' | 'float' | 'string' | 'json' | 'boolean' | 'datetime';
  user_id: number;
}

/** User account data serialised by dehydrate() — model fields only, no relations */
export interface IUserProfile {
  Id: number;
  Uuid: string;
  Email: string;
  Login: string;
  Role: string[];
  CreatedAt: string;
  RegisteredAt: string;
  DeletedAt: string | null;
  LastLoginAt: string | null;
  IsActive: boolean;
}

/** User account data serialised by dehydrateWithRelations() — includes optional loaded relations */
export interface IUserData extends IUserProfile {
  Metadata?: IUserMetadataEntry[];
}

/** Flattened RBAC grants for a user: resource → action → permission descriptor */
export type IGrantsMap = Record<string, Record<string, { attributes: string[] }>>;

/** Successful authentication response — user profile merged with RBAC grants */
export interface IUserWithGrants extends IUserProfile {
  /**
   * Currently active role used for request-bound permission checks.
   * Picked from User.Role; defaults to User.Role[0] at login.
   */
  ActiveRole: string;

  Grants: IGrantsMap;
}

/** Response for /auth/active-role endpoints */
export interface IActiveRoleResponse {
  ActiveRole: string;
  AvailableRoles: string[];
  Grants: IGrantsMap;
}

/** Login response when TOTP verification step is still pending */
export interface ITwoFactorAuthRequired {
  TwoFactorAuthRequired: true;
}

/** Login response when initial TOTP device setup is required before first use */
export interface ITwoFactorInitRequired {
  TwoFactorInitRequired: true;
}

/** All possible shapes returned by the login endpoint */
export type ILoginResponse = IUserWithGrants | ITwoFactorAuthRequired | ITwoFactorInitRequired;

/** Response returned when TOTP is successfully enabled for a user */
export interface IEnable2faResponse {
  /** OTP provisioning URI — scan with an authenticator app (e.g. Google Authenticator) */
  otp: string;
}


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

    /**
     * Currently selected role from User.Role for the request. Defaults to the
     * first role in User.Role at login; can be changed via /auth/active-role.
     */
    ActiveRole?: string;
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
   * Disable for user 2fa
   * 
   * @param user 
   */
  public abstract disable(user : User) : Promise<void>;

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

  /**
   * 
   * Gets the OTP Auth URL for the user. It is used to generate QR code for 2fa apps like Google Authenticator.
   * 
   * @param user 
   */
  public abstract getOtpAuthUrl(user: User): Promise<string | null>;
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
