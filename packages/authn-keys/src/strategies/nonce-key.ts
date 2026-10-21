import { createHash } from 'node:crypto';

/** A fixed-length store key for a value a client chose, scoped to the key that signed it. */
export const nonceKey = (scope: 'jti' | 'sig', kid: string, value: string): string => `${scope}:${createHash('sha256').update(`${kid}\n${value}`, 'utf8').digest('base64url')}`;
