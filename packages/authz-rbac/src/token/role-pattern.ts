// A role name, or a 'prefix.*' pattern: a full glob in a security list is refused on purpose.
export const ROLE_OR_PREFIX = /^[^*]+(\.\*)?$/;
