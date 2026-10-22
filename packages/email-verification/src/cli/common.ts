import { InvalidArgument } from '@spinajs/exceptions';
import { LIST_KINDS } from '../contracts.js';
import type { ListKind } from '../contracts.js';
import { normalizeDomain } from '../domain.js';

export function domainsArg(values: readonly string[]): string[] {
  const invalid = values.filter((v) => normalizeDomain(v) === null);
  if (invalid.length > 0) throw new InvalidArgument(`not a domain: ${invalid.join(', ')}`);
  return [...new Set(values.map((v) => normalizeDomain(v)!))];
}

export function kindArg(value: string): ListKind {
  if (!(LIST_KINDS as readonly string[]).includes(value)) throw new InvalidArgument(`kind must be one of ${LIST_KINDS.join(', ')}`);
  return value as ListKind;
}
