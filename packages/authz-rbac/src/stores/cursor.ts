import { AuthzAdminFailure } from '@spinajs/authz';

const SEPARATOR = '|';

/** An opaque keyset cursor: base64url of the sort key parts joined by `|`. */
export function encodeCursor(...parts: readonly string[]): string {
  return Buffer.from(parts.join(SEPARATOR), 'utf8').toString('base64url');
}

export function invalidCursor(where: string): AuthzAdminFailure {
  return new AuthzAdminFailure('invalid_page', `${where}: page.after is not a cursor this list issued`, 'page.after');
}

export function cursorWithOffset(where: string): AuthzAdminFailure {
  return new AuthzAdminFailure('invalid_page', `${where}: page.after cannot be combined with page.offset`, 'page.after');
}

/** The `count` parts of a cursor (the last may hold `|`); anything `encodeCursor` could not have produced is `invalid_page`. */
export function decodeCursor(cursor: string, count: number, where: string): string[] {
  if (typeof cursor !== 'string') throw invalidCursor(where);
  let rest = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts: string[] = [];
  for (let i = 1; i < count; i++) {
    const at = rest.indexOf(SEPARATOR);
    if (at <= 0) throw invalidCursor(where);
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  // Re-encoding rejects what base64url decoding would forgive (stray characters, non-canonical padding bits).
  if (rest === '' || encodeCursor(...parts) !== cursor) throw invalidCursor(where);
  return parts;
}
