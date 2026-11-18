import { InvalidArgument } from '@spinajs/exceptions';
import { InvalidInput } from './paging.js';

/** Ceiling of relations one request may ask for. */
export const MAX_INCLUDES = 16;

const throwInvalidArgument: InvalidInput = (field, message) => {
  throw new InvalidArgument(message, field);
};

function names(input: unknown, invalid: InvalidInput): unknown {
  if (typeof input !== 'string') {
    return input;
  }

  const text = input.trim();
  if (!text.startsWith('[')) {
    return text
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid('include', 'include is invalid JSON');
  }
}

/**
 * The relations a request asks to load, from `?include=A,B`, `?include=["A","B"]` or a list:
 * each must be in `includable`, repeats are dropped, absent input is no relations.
 */
export function readInclude(input: unknown, includable: readonly string[], options: { invalid?: InvalidInput } = {}): string[] {
  const invalid = options.invalid ?? throwInvalidArgument;

  if (input === undefined || input === null || input === '') {
    return [];
  }

  const requested = names(input, invalid);
  if (!Array.isArray(requested) || requested.some((name) => typeof name !== 'string')) {
    return invalid('include', 'include is a comma separated text or a list of relation names');
  }
  if (requested.length > MAX_INCLUDES) {
    return invalid('include', `include names ${requested.length} relations, at most ${MAX_INCLUDES} are allowed`);
  }

  const result: string[] = [];
  for (const name of requested as string[]) {
    if (!includable.includes(name)) {
      return invalid('include', `Cannot include ${JSON.stringify(name)}. Includable relations are: ${includable.join(', ')}`);
    }
    if (!result.includes(name)) {
      result.push(name);
    }
  }
  return result;
}
