import { AuthzAdminFailure } from '@spinajs/authz';
import { sortedUnique } from '@spinajs/util';

const SEPARATOR = ',';

/**
 * Tags as stored: sorted, deduplicated, wrapped in commas (`,a,b,`) so SQL can match one
 * with `LIKE '%,a,%'`; no tags is `''`. Throws `AuthzAdminFailure('invalid_tags')` naming the first
 * tag that is not a non-empty string free of the separator.
 */
export function normaliseTags(tags: readonly string[] | undefined | null): string {
  if (tags == null || tags.length === 0) return '';

  for (const tag of tags) {
    if (typeof tag !== 'string' || tag === '' || tag.includes(SEPARATOR)) {
      throw new AuthzAdminFailure('invalid_tags', `Tag ${JSON.stringify(tag)} is invalid: a tag is a non-empty string without "${SEPARATOR}"`, 'tags');
    }
  }

  return `${SEPARATOR}${sortedUnique(tags).join(SEPARATOR)}${SEPARATOR}`;
}

/** The stored text back as a sorted list; `''` (or null) is `[]`. */
export function parseTags(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.split(SEPARATOR).filter((t) => t !== '');
}
