import { Schema } from '@spinajs/validation';
import { bodyOf, identityRefField } from '@spinajs/authn/schemas';

import { AuthnInput, inlinePasswordField } from './base.js';

@Schema(bodyOf(['target'], { target: { ...identityRefField, description: 'a user id, or { type, id }' }, password: inlinePasswordField }, 'authn.ImpersonationBody'))
export class AuthnImpersonationBody extends AuthnInput {
  public readonly target: string | { readonly type: string; readonly id: string };
  public readonly password?: string;
}
