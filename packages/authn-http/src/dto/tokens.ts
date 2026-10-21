import { Schema } from '@spinajs/validation';
import { bodyOf, fieldSchema, isoInstantField, tokenIdField, tokenSecretField } from '@spinajs/authn/schemas';

import { AuthnInput, bounded, inlinePasswordField } from './base.js';

/** authn-token's own limits on a token name and its scope entries. */
const NAME_CAP = 128;
const ROLE_CAP = 128;
const ROLES_MAX = 64;
const PROFILE_CAP = 128;
const SCOPE_STRING_CAP = 256;
const SCOPE_ENTRIES_MAX = 1000;
/** The longest grace a rotation may leave the old secret: seven days, as in authn-token. */
const GRACE_MAX = 604_800;

const nameField = { ...bounded(NAME_CAP), pattern: '\\S' } as const;
const rolesField = { type: 'array', maxItems: ROLES_MAX, items: bounded(ROLE_CAP) } as const;

const scopeField = {
  type: 'object',
  additionalProperties: false,
  properties: {
    permissions: { type: 'array', maxItems: SCOPE_ENTRIES_MAX, items: bounded(SCOPE_STRING_CAP) },
    resources: {
      type: 'array',
      maxItems: SCOPE_ENTRIES_MAX,
      items: { type: 'object', additionalProperties: false, required: ['type'], properties: { type: bounded(SCOPE_STRING_CAP), id: bounded(SCOPE_STRING_CAP) } },
    },
    agent: { type: 'boolean' },
  },
} as const;

export const TOKEN_ID_PARAM = fieldSchema('authn.param.tokenId', tokenIdField);

@Schema(
  bodyOf(
    ['name', 'expiresAt'],
    {
      name: nameField,
      expiresAt: isoInstantField,
      kind: { type: 'string', enum: ['pat', 'service', 'agent'] },
      roles: rolesField,
      profile: bounded(PROFILE_CAP),
      scope: scopeField,
      reauthPassword: inlinePasswordField,
    },
    'authn.TokenCreateBody',
  ),
)
export class AuthnTokenCreateBody extends AuthnInput {
  public readonly name: string;
  public readonly expiresAt: string;
  public readonly kind?: 'pat' | 'service' | 'agent';
  public readonly roles?: readonly string[];
  public readonly profile?: string;
  public readonly scope?: { readonly permissions?: readonly string[]; readonly resources?: readonly { readonly type: string; readonly id?: string }[]; readonly agent?: boolean };
  public readonly reauthPassword?: string;
}

@Schema(bodyOf([], { graceSeconds: { type: 'integer', minimum: 0, maximum: GRACE_MAX }, reauthPassword: inlinePasswordField }, 'authn.TokenRotateBody'))
export class AuthnTokenRotateBody extends AuthnInput {
  public readonly graceSeconds?: number;
  public readonly reauthPassword?: string;
}

// An empty list would unpin the token, which is not narrowing.
@Schema(bodyOf([], { name: nameField, roles: { ...rolesField, minItems: 1 }, expiresAt: isoInstantField }, 'authn.TokenUpdateBody'))
export class AuthnTokenUpdateBody extends AuthnInput {
  public readonly name?: string;
  public readonly roles?: readonly string[];
  public readonly expiresAt?: string;
}

@Schema(bodyOf(['token'], { token: tokenSecretField }, 'authn.TokenRevokeBody'))
export class AuthnTokenRevokeBody extends AuthnInput {
  public readonly token: string;
}
