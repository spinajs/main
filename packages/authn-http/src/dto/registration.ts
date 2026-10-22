import { Schema } from '@spinajs/validation';
import { bodyOf, passwordField } from '@spinajs/authn/schemas';

import { AuthnInput, bounded } from './base.js';

/** The `authn_identity` login and the users email column. */
export const IDENTIFIER_CAP = 254;

@Schema(
  bodyOf(
    ['login', 'email', 'password'],
    { login: bounded(IDENTIFIER_CAP), email: { ...bounded(IDENTIFIER_CAP), format: 'email' }, password: passwordField, confirmPassword: passwordField },
    'authn.RegistrationBody',
  ),
)
export class AuthnRegistrationBody extends AuthnInput {
  public readonly login: string;
  public readonly email: string;
  public readonly password: string;
  public readonly confirmPassword?: string;
}
