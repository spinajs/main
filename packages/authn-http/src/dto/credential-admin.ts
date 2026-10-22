import { Schema } from '@spinajs/validation';
import { bodyOf, fieldSchema } from '@spinajs/authn/schemas';

import { AuthnInput, inlinePasswordField } from './base.js';

/**
 * users' identities are lower-case uuids (users.Uuid); anything else names no user. Case-sensitive on purpose: under a
 * `_ci` collation an upper-case id finds and expires the user while the session store, keyed by the exact id, revokes
 * nothing.
 */
export const USER_ID_PARAM = fieldSchema('authn.param.userId', { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } as const);

@Schema(bodyOf([], { sendReset: { type: 'boolean', description: 'also mail the user a reset link (default true)' }, reauthPassword: inlinePasswordField }, 'authn.AdminPasswordResetBody'))
export class AuthnAdminPasswordResetBody extends AuthnInput {
  public readonly sendReset?: boolean;
  public readonly reauthPassword?: string;
}
