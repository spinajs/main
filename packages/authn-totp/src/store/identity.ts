import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';
import { _check_arg, _is_string, _non_empty } from '@spinajs/util';

/** `${type}:${id}`, the row key authn-orm's `DbMfaStore` uses; too long throws rather than truncates. */
export function identityKey(ref: IdentityRef, maxLength = 100): string {
  _check_arg(_is_string(_non_empty()))(ref?.type, 'identity type');
  if (ref.type.includes(':')) {
    throw new InvalidArgument(`identity type "${ref.type}" contains ":"`);
  }
  const key = `${ref.type}:${ref.id}`;
  if (key.length > maxLength) {
    throw new InvalidArgument(`identity key of type "${ref.type}" is ${key.length} characters long, the column holds ${maxLength}`);
  }
  return key;
}
