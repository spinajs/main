import type { PrincipalRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

/** A subject label as L14's parseSubjectLabel reads it: `<type>:<id>`, the id everything after the first `:`. */
export const SUBJECT_PATTERN = '^[^:]+:.+$';

/** A user only: ownership goes to a person, never to a set. */
export function parseUser(text: unknown, field: string): PrincipalRef {
  if (typeof text === 'string' && text.startsWith('user:') && text.length > 'user:'.length) return Object.freeze({ type: 'user', id: text.slice('user:'.length) });
  throw new InvalidArgument(`${field} must be user:<id>`, field);
}
