import { AuthzAdminFailure } from '@spinajs/authz';
import { sortedUnique } from '@spinajs/util';

import { ASSIGNMENT_COLUMN_WIDTHS } from './columns.js';

const SEPARATOR = ',';

/**
 * Tags as stored: sorted, deduplicated, wrapped in commas (`,a,b,`) so SQL can match one
 * with `LIKE '%,a,%'`; no tags is `''`. Throws `AuthzAdminFailure('invalid_tags')` naming the first
 * tag that is not a non-empty string free of the separator, or when the text is wider than its column.
 */
export function normaliseTags(tags: readonly string[] | undefined | null): string {
  if (tags == null || tags.length === 0) return '';

  for (const tag of tags) {
    if (typeof tag !== 'string' || tag === '' || tag.includes(SEPARATOR)) {
      throw new AuthzAdminFailure('invalid_tags', `Tag ${JSON.stringify(tag)} is invalid: a tag is a non-empty string without "${SEPARATOR}"`, 'tags');
    }
  }

  const text = `${SEPARATOR}${sortedUnique(tags).join(SEPARATOR)}${SEPARATOR}`;
  if (text.length > ASSIGNMENT_COLUMN_WIDTHS.tags) {
    throw new AuthzAdminFailure('invalid_tags', `The tags take ${text.length} characters as stored; the column holds ${ASSIGNMENT_COLUMN_WIDTHS.tags}`, 'tags');
  }
  return text;
}

/** The stored text back as a sorted list; `''` (or null) is `[]`. */
export function parseTags(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.split(SEPARATOR).filter((t) => t !== '');
}
