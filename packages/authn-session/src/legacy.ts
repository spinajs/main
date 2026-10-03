import type { ISession } from './contracts.js';

/** 2.x session ids were lowercase uuid v4; 3.0 raw ids (22 base64url chars) and storage keys (64 hex) never match. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isLegacySessionId = (id: unknown): id is string => typeof id === 'string' && UUID_V4.test(id);

/** Data entries 2.x wrote that the 3.0 row carries as typed members. */
export const LEGACY_IDENTITY_KEYS = ['User', 'Authorized', 'Impersonator'] as const;

/**
 * The 3.0 view of a stored row. A row with a Subject is returned as is. A row
 * written by 2.x has none: its Subject comes from Data 'User' (a users.Uuid),
 * Impersonator from 'Impersonator', and State is 'active' only when
 * 'Authorized' is true. A 2.x row without 'User' is absent (null).
 */
export function adaptLegacySession<T extends ISession>(row: T): T | null {
  if (row.Subject) {
    return row;
  }
  const user = row.Data?.get('User');
  if (typeof user !== 'string' || user.length === 0) {
    return null;
  }
  const impersonator = row.Data.get('Impersonator');
  return Object.assign(Object.create(Object.getPrototypeOf(row)) as T, row, {
    Subject: { type: 'user', id: user },
    Impersonator: typeof impersonator === 'string' && impersonator.length > 0 ? { type: 'user', id: impersonator } : undefined,
    State: row.Data.get('Authorized') === true ? 'active' : 'pending',
  });
}
