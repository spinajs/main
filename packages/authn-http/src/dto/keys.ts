import { Schema } from '@spinajs/validation';
import { bodyOf, fieldSchema, isoInstantField, kidField } from '@spinajs/authn/schemas';

import { AuthnInput, NO_CONTROL_CHARACTERS, bounded, inlinePasswordField } from './base.js';

/** authn-keys' own limit on a key name. */
export const KEY_NAME_CAP = 128;
/** Above authn-keys' longest challenge id (16 + 1 + 512). */
const CHALLENGE_ID_CAP = 600;
/** Ed25519 and P-256 (IEEE P1363) signatures are 64 bytes, 86 characters of base64url. */
const SIGNATURE_CAP = 128;

/** A public JWK as WebCrypto exports it (`key_ops`, `ext` included); KeyRegistry checks the key itself. */
const jwkField = {
  type: 'object',
  description: 'an Ed25519 (OKP) or P-256 (EC) public JWK',
  minProperties: 1,
  maxProperties: 8,
  additionalProperties: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'boolean' }, { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 32 } }] },
} as const;

const proofField = {
  type: 'object',
  description: 'the signature over a register challenge of this user',
  additionalProperties: false,
  required: ['challengeId', 'signature'],
  properties: { challengeId: bounded(CHALLENGE_ID_CAP), signature: bounded(SIGNATURE_CAP) },
} as const;

export const KID_PARAM = fieldSchema('authn.param.kid', kidField);

@Schema(
  bodyOf(
    ['jwk', 'proof'],
    {
      jwk: jwkField,
      proof: proofField,
      kid: kidField,
      name: { ...bounded(KEY_NAME_CAP), pattern: NO_CONTROL_CHARACTERS },
      expiresAt: isoInstantField,
      reauthPassword: inlinePasswordField,
    },
    'authn.KeyRegisterBody',
  ),
)
export class AuthnKeyRegisterBody extends AuthnInput {
  public readonly jwk: Record<string, unknown>;
  public readonly proof: { readonly challengeId: string; readonly signature: string };
  public readonly kid?: string;
  public readonly name?: string;
  public readonly expiresAt?: string;
  public readonly reauthPassword?: string;
}

@Schema({
  ...bodyOf(['purpose'], { purpose: { type: 'string', enum: ['login', 'register'] }, kid: { ...kidField, description: 'the key to log in with (purpose login)' } }, 'authn.KeyChallengeBody'),
  if: { properties: { purpose: { const: 'login' } } },
  then: { required: ['kid'] },
})
export class AuthnKeyChallengeBody extends AuthnInput {
  public readonly purpose: 'login' | 'register';
  public readonly kid?: string;
}

@Schema(bodyOf(['keyId', 'challengeId', 'signature'], { keyId: kidField, challengeId: bounded(CHALLENGE_ID_CAP), signature: bounded(SIGNATURE_CAP) }, 'authn.KeyLoginBody'))
export class AuthnKeyLoginBody extends AuthnInput {
  public readonly keyId: string;
  public readonly challengeId: string;
  public readonly signature: string;
}
