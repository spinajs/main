import { Schema } from '@spinajs/validation';
import { bodyOf } from '@spinajs/authn/schemas';

import { AuthnInput, inlinePasswordField } from './base.js';

@Schema(bodyOf(['password'], { password: { ...inlinePasswordField, minLength: 1, description: 'the account password' } }, 'authn.ReauthBody'))
export class AuthnReauthBody extends AuthnInput {
  public readonly password: string;
}

/** The body of a FreshAuth route whose only input is the password of a stale session. */
@Schema(bodyOf([], { reauthPassword: inlinePasswordField }, 'authn.ReauthPasswordBody'))
export class AuthnReauthPasswordBody extends AuthnInput {
  public readonly reauthPassword?: string;
}
