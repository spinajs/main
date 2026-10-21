import { Schema } from '@spinajs/validation';
import { bodyOf, fieldSchema } from '@spinajs/authn/schemas';

import { AuthnInput, NO_CONTROL_CHARACTERS, bounded, inlinePasswordField } from './base.js';

/** Above the challenge ids authn-webauthn draws (22 characters). */
const CHALLENGE_ID_CAP = 64;
/** WebAuthn caps credential ids at 1023 bytes, 1364 characters of base64url. */
const CREDENTIAL_ID = '^[A-Za-z0-9_-]{1,1364}$';
export const PASSKEY_NAME_CAP = 64;
/** Fits any attestation or assertion member as base64url. */
const MEMBER_CAP = 65536;

const member = { type: 'string', maxLength: MEMBER_CAP } as const;

/**
 * The browser's RegistrationResponseJSON or AuthenticationResponseJSON. Open below the top level: browsers add members
 * (`publicKey`, `transports`, extension results); authn-webauthn checks the ones it reads.
 */
const credentialResponseField = {
  type: 'object',
  description: "the browser's credential as JSON (RegistrationResponseJSON or AuthenticationResponseJSON)",
  maxProperties: 16,
  required: ['id', 'type', 'response'],
  properties: {
    id: { type: 'string', pattern: CREDENTIAL_ID },
    rawId: { type: 'string', pattern: CREDENTIAL_ID },
    type: { type: 'string', maxLength: 32 },
    authenticatorAttachment: { type: 'string', maxLength: 32 },
    clientExtensionResults: { type: 'object', maxProperties: 32 },
    response: {
      type: 'object',
      maxProperties: 16,
      properties: { clientDataJSON: member, authenticatorData: member, signature: member, userHandle: member, attestationObject: member },
    },
  },
} as const;

export const PASSKEY_ID_PARAM = fieldSchema('authn.param.passkeyId', { type: 'string', pattern: CREDENTIAL_ID } as const);

@Schema(bodyOf(['challengeId', 'response'], { challengeId: bounded(CHALLENGE_ID_CAP), response: credentialResponseField }, 'authn.PasskeyLoginBody'))
export class AuthnPasskeyLoginBody extends AuthnInput {
  public readonly challengeId: string;
  public readonly response: Record<string, unknown>;
}

@Schema(
  bodyOf(
    ['challengeId', 'response'],
    { challengeId: bounded(CHALLENGE_ID_CAP), response: credentialResponseField, name: { ...bounded(PASSKEY_NAME_CAP), pattern: NO_CONTROL_CHARACTERS }, reauthPassword: inlinePasswordField },
    'authn.PasskeyRegisterBody',
  ),
)
export class AuthnPasskeyRegisterBody extends AuthnInput {
  public readonly challengeId: string;
  public readonly response: Record<string, unknown>;
  public readonly name?: string;
  public readonly reauthPassword?: string;
}
