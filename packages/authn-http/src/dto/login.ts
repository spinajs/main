import { Schema } from '@spinajs/validation';
import { bodyOf, loginField, passwordField } from '@spinajs/authn/schemas';

import { AuthnInput } from './base.js';

@Schema(bodyOf(['login', 'password'], { login: loginField, password: passwordField }, 'authn.LoginBody'))
export class AuthnLoginBody extends AuthnInput {
  public readonly login: string;
  public readonly password: string;
}
