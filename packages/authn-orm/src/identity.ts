import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';

/** `${type}:${id}`, the form `identity` and `actor` columns hold (D1). Never truncates: too long throws. */
export function identityKey(ref: IdentityRef, maxLength = 100): string {
  if (!ref.type) {
    throw new InvalidArgument('identity type is empty');
  }
  if (ref.type.includes(':')) {
    throw new InvalidArgument(`identity type "${ref.type}" contains ":"`);
  }

  const key = `${ref.type}:${ref.id}`;
  if (key.length > maxLength) {
    throw new InvalidArgument(`identity key of type "${ref.type}" is ${key.length} characters long, the column holds ${maxLength}`);
  }
  return key;
}

/** Splits at the first `:`; the id may contain more. */
export function parseIdentityKey(key: string): IdentityRef {
  const at = key.indexOf(':');
  if (at <= 0) {
    throw new InvalidArgument('identity key is not of the form <type>:<id>');
  }
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}
