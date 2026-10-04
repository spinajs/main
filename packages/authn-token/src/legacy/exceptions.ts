import { Exception } from '@spinajs/exceptions';

/**
 * Base class for access token failures. `data` carries a transport-agnostic
 * payload ( token uuid, refused roles ) that middleware / controllers log or
 * translate into responses. Named AccessToken* so the classes stay distinct
 * from the password-reset TokenExpired / TokenInvalid in `@spinajs/users` -
 * the http error map is keyed by constructor name.
 *
 * @deprecated 2.x API; use TokenService. R1 removes it.
 */
export class AccessTokenException extends Exception {
  constructor(message?: string, public data?: unknown, inner?: Error | unknown) {
    super(message, inner);
  }
}

/**
 * Thrown when no access token matches the presented value.
 *
 * @deprecated 2.x API; use TokenService. R1 removes it.
 */
export class AccessTokenNotFound extends AccessTokenException {}

/**
 * Thrown when the access token has expired.
 *
 * @deprecated 2.x API; use TokenService. R1 removes it.
 */
export class AccessTokenExpired extends AccessTokenException {}

/**
 * Thrown when the token owner may no longer authenticate ( banned / inactive / deleted ).
 *
 * @deprecated 2.x API; use TokenService. R1 removes it.
 */
export class AccessTokenOwnerInvalid extends AccessTokenException {}

/**
 * Thrown when a role / profile may not be pinned to or revoked from a token.
 *
 * @deprecated 2.x API; use TokenService. R1 removes it.
 */
export class AccessTokenRoleNotAllowed extends AccessTokenException {}
