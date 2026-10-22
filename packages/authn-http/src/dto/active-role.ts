import { Schema } from '@spinajs/validation';
import { bodyOf } from '@spinajs/authn/schemas';

import { AuthnInput, bounded, inlinePasswordField } from './base.js';

export const ROLE_CAP = 256;

@Schema(bodyOf(['role'], { role: bounded(ROLE_CAP), password: { ...inlinePasswordField, description: 'when the role asks for a fresh password' } }, 'authn.ActiveRoleBody'))
export class AuthnActiveRoleBody extends AuthnInput {
  public readonly role: string;
  public readonly password?: string;
}
