import { Schema } from '@spinajs/validation';
import { bodyOf, codeField, loginField } from '@spinajs/authn/schemas';

import { AuthnInput } from './base.js';

@Schema(bodyOf(['login'], { login: loginField }, 'authn.CodeRequestBody'))
export class AuthnCodeRequestBody extends AuthnInput {
  public readonly login: string;
}

@Schema(bodyOf(['login', 'code'], { login: loginField, code: codeField }, 'authn.CodeLoginBody'))
export class AuthnCodeLoginBody extends AuthnInput {
  public readonly login: string;
  public readonly code: string;
}
