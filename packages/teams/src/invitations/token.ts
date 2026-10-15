import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { AuthzConfigError } from '@spinajs/authz';

import { INVITATION_SECRET_MIN_LENGTH } from '../schema.js';

export const INVITATION_SECRET_KEY = 'teams.invitations.secret';
export const INVITATION_TOKEN_MAX_LENGTH = 128;
const TOKEN_BYTES = 32;

export const newInvitationToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

/** `v1:<hex HMAC-SHA256(secret, token)>`; the prefix names the key so a rotation can add v2 (as share links do). */
export const invitationTokenHash = (secret: string, token: string): string => `v1:${createHmac('sha256', secret).update(token, 'utf8').digest('hex')}`;

/** Read on every use: the service resolves before an app sets the secret, and a runtime set skips the schema. */
export function readInvitationSecret(v: unknown): string {
  if (typeof v !== 'string' || v.length < INVITATION_SECRET_MIN_LENGTH) {
    throw new AuthzConfigError(`${INVITATION_SECRET_KEY} must be set to hash invitation tokens: a string of at least ${INVITATION_SECRET_MIN_LENGTH} characters`);
  }
  return v;
}

/** Defence in depth: the row was found by this hash; the keyed hash is what makes the indexed lookup timing-safe. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
