import { Schema } from '@spinajs/validation';
import { bodyOf, codeField } from '@spinajs/authn/schemas';

import { AuthnInput, inlinePasswordField } from './base.js';

@Schema(bodyOf(['code'], { code: { ...codeField, description: 'a TOTP code or a recovery code' }, reauthPassword: inlinePasswordField }, 'authn.MfaDisableBody'))
export class AuthnMfaDisableBody extends AuthnInput {
  public readonly code: string;
  public readonly reauthPassword?: string;
}
