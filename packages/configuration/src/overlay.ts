import _ from 'lodash';

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean => prefix.length <= path.length && prefix.every((s, i) => path[i] === s);

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/**
 * What a read of `segments` answers once the overlay `values` (by dotted path) lie over the merged `config`: the value of
 * the most specific overridden path at or above `segments`, with every override below `segments` written into a deep
 * copy of it. Undefined when no override touches `segments`.
 */
export function overlaidValue(config: object, segments: readonly string[], values: ReadonlyMap<string, unknown>): { value: unknown } | undefined {
  let above: { at: string[]; value: unknown } | undefined;
  const below: Array<[string[], unknown]> = [];
  for (const [path, value] of values) {
    const at = path.split('.');
    if (startsWith(segments, at)) {
      if (above === undefined || at.length > above.at.length) above = { at, value };
    } else if (startsWith(at, segments)) {
      below.push([at.slice(segments.length), value]);
    }
  }

  if (above === undefined && below.length === 0) return undefined;
  const rest = above === undefined ? [] : segments.slice(above.at.length);
  const base: unknown = above === undefined ? _.get(config, [...segments]) : rest.length === 0 ? above.value : _.get(above.value, rest);
  if (below.length === 0) return { value: base };

  const copy: object = isObject(base) ? _.cloneDeep(base) : {};
  for (const [at, value] of below) _.set(copy, at, _.cloneDeep(value));
  return { value: copy };
}
