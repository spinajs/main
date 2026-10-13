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
 * Thrown by `create()` when a step after the grants failed: the account exists and keeps its roles, so a retry
 * would get {@link UserAlreadyExists}. `data`: `user` (the Uuid), `resendInvite` (the invite was due and the invite
 * call did not complete: send it with `PasswordService.invite`; false does not mean a mail went out, as an invite with
 * no `PasswordMailer` completes without one), `error` (the failure's class; its message is left out, it may echo a
 * secret).
 */
export class UserCreatedIncomplete extends RbacException {
  public declare data: { user: string; resendInvite: boolean; error: string };
}

/**
 * Thrown when user metadata relation was not populated before use.
 */
export class MetadataNotPopulated extends RbacException {}

/**
 * Thrown when a metadata key is missing from user data.
 */
export class MetadataNotFound extends RbacException {}

/**
 * Thrown when a rbac email template is not configured ( users.email in config ).
 */
export class EmailTemplateNotConfigured extends RbacException {}
