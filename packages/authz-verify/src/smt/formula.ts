/** A number, or a numeric context variable (real for `double` parameters, integer otherwise). */
export type Term = number | { readonly num: string; readonly real?: boolean };

/** A formula over boolean variables (tuples, definitions, boolean parameters) and comparisons of terms. */
export type Formula =
  | boolean
  | { readonly var: string }
  | { readonly not: Formula }
  | { readonly and: readonly Formula[] }
  | { readonly or: readonly Formula[] }
  | { readonly cmp: 'eq' | 'lt' | 'le'; readonly a: Term; readonly b: Term };

export function and(...xs: Formula[]): Formula {
  if (xs.includes(false)) return false;
  const rest = xs.filter((x) => x !== true);
  return rest.length === 0 ? true : rest.length === 1 ? rest[0] : { and: rest };
}

export function or(...xs: Formula[]): Formula {
  if (xs.includes(true)) return true;
  const rest = xs.filter((x) => x !== false);
  return rest.length === 0 ? false : rest.length === 1 ? rest[0] : { or: rest };
}

export const not = (x: Formula): Formula => (typeof x === 'boolean' ? !x : 'not' in x ? x.not : { not: x });

/** A part of the IR the bounded encoding does not model; the query answers `unknown`. */
export class Unsupported extends Error {}
