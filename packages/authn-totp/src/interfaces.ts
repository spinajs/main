import { User } from '@spinajs/users';
import { MethodNotImplemented } from '@spinajs/exceptions';

export abstract class TwoFactorAuthProvider {
  /**
   * generate secret key if this provider use is needs it or null
   */
  public abstract initialize(user: User): Promise<any | null>;

  /**
   * Generate and store the secret WITHOUT switching 2fa on. The account is left
   * pending: it has a device to verify against, but the login check does not
   * demand a code yet.
   *
   * Providers that cannot express a pending state may leave this unimplemented;
   * only the routes that confirm enrolment call it.
   */
  public beginEnrolment(_user: User): Promise<any | null> {
    throw new MethodNotImplemented('this 2fa provider does not support pending enrolment');
  }

  /**
   * Switch 2fa on for an account whose secret was already stored by
   * {@link beginEnrolment}.
   */
  public activate(_user: User): Promise<void> {
    throw new MethodNotImplemented('this 2fa provider does not support pending enrolment');
  }

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
