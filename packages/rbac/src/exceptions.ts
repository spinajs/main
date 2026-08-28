import { Exception } from '@spinajs/exceptions';

/**
 * Base class for all rbac exceptions. `data` carries a transport-agnostic
 * payload ( eg. which fields clashed, which user was refused ) that http
 * controllers translate into response bodies.
 */
export class RbacException extends Exception {
  constructor(message?: string, public data?: unknown, inner?: Error | unknown) {
    super(message, inner);
  }
}

/**
 * Base class for authentication failures ( login flow ). Controllers collapse
 * every subclass into one opaque 401 so responses stay account-state blind.
 */
export class AuthenticationException extends RbacException {}

/**
 * Thrown when credentials do not match any active account.
 */
export class InvalidCredentials extends AuthenticationException {}

/**
 * Thrown when the account is inside a lockout window after too many failed logins.
 */
export class LoginAttemptsExceeded extends AuthenticationException {}

/**
 * Thrown when the user is banned - during authentication and when a
 * ban / unban / password-reset action refuses to run on a banned account.
 * ( named UserIsBanned - the UserBanned name is taken by the domain event )
 */
export class UserIsBanned extends AuthenticationException {}

/**
 * Thrown when the user account is not active ( or deleted ).
 */
export class UserNotActive extends AuthenticationException {}

/**
 * Thrown when login or email is already taken. `data.fields` names which.
 */
export class UserAlreadyExists extends RbacException {}

/**
 * Thrown when user metadata relation was not populated before use.
 */
export class MetadataNotPopulated extends RbacException {}

/**
 * Thrown when a metadata key is missing from user data.
 */
export class MetadataNotFound extends RbacException {}

/**
 * Thrown when a rbac email template is not configured ( rbac.email in config ).
 */
export class EmailTemplateNotConfigured extends RbacException {}

/**
 * Thrown when a password change / reset token has expired.
 */
export class TokenExpired extends RbacException {}

/**
 * Thrown when a password change / reset token does not match.
 */
export class TokenInvalid extends RbacException {}
