import { Schema } from '@spinajs/validation';
import { bodyOf, loginField, passwordField, secretField } from '@spinajs/authn/schemas';

import { AuthnInput } from './base.js';

@Schema(bodyOf(['login'], { login: loginField }, 'authn.PasswordResetRequestBody'))
export class AuthnPasswordResetRequestBody extends AuthnInput {
  public readonly login: string;
}

@Schema(bodyOf(['login', 'secret', 'password'], { login: loginField, secret: secretField, password: passwordField, confirmPassword: passwordField }, 'authn.PasswordResetBody'))
export class AuthnPasswordResetBody extends AuthnInput {
  public readonly login: string;
  public readonly secret: string;
  public readonly password: string;
  public readonly confirmPassword?: string;
}

@Schema(bodyOf(['oldPassword', 'password'], { oldPassword: passwordField, password: passwordField, confirmPassword: passwordField }, 'authn.PasswordChangeBody'))
export class AuthnPasswordChangeBody extends AuthnInput {
  public readonly oldPassword: string;
  public readonly password: string;
  public readonly confirmPassword?: string;
}
