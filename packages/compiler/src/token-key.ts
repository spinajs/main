const PREFIX = 'token:unresolved:';

/** Reserved DI key for a token constant whose real key cannot be read; no string registration produces this form. */
export function unresolvedTokenKey(module: string, name: string): string {
  return `${PREFIX}${module}#${name}`;
}

export function isUnresolvedTokenKey(key: string): boolean {
  return key.startsWith(PREFIX);
}
