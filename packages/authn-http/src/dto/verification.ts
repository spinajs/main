import { Schema } from '@spinajs/validation';
import { bodyOf, secretField } from '@spinajs/authn/schemas';

import { AuthnInput } from './base.js';

@Schema(bodyOf(['secret'], { secret: secretField }, 'authn.VerifyBody'))
export class AuthnVerifyBody extends AuthnInput {
  public readonly secret: string;
}
