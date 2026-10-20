import { ROLE_NAME_PATTERN } from '@spinajs/authz';

// A role name, or 'prefix.*' with a prefix that is one: an entry no role can match would silently exclude nothing. The
// lookahead keeps a star out of everything but the suffix, so a full glob in a security list is refused on purpose.
export const ROLE_OR_PREFIX = new RegExp(String.raw`^(?=[^*]+(?:\.\*)?$)(?:${ROLE_NAME_PATTERN.slice(1, -1)})(?:\.\*)?$`);
