import { AuthzConfigError, filterObject } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

// The value filterObject (like JSON.stringify) sees: toJSON(key) first.
const toJson = (v: unknown, key: string): unknown => {
  if (v !== null && (typeof v === 'object' || typeof v === 'function')) {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') return toJSON.call(v, key);
  }
  return v;
};

const join = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

// A key filterObject left out because the fields deny it, not because JSON has no value for it.
// A getter is not called: filterObject does not read a denied key either.
const dropped = (obj: Rec, key: string): boolean => {
  if (key === '__proto__') return true;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (d === undefined) return false;
  if (!('value' in d)) return true;
  return d.value !== undefined && typeof d.value !== 'function' && typeof d.value !== 'symbol';
};

/** Every field of `input` as removed: a record's keys, and those of the records in an array. */
function dropAll(input: unknown, path: string, removed: Set<string>): void {
  if (Array.isArray(input)) input.forEach((e, i) => dropAll(toJson(e, String(i)), path, removed));
  else if (isRecord(input)) for (const key of Object.keys(input)) if (dropped(input, key)) removed.add(join(path, key));
}

/**
 * Adds the paths of `input` (JSON-shaped) that `output` (filterObject's result for it) lacks. A
 * subtree dropped whole is one path; array indexes are not part of a path, so an array's path stands
 * for the scalar elements filterObject dropped from it. `top`: in a top-level array filterObject
 * keeps every element.
 */
function diff(input: unknown, output: unknown, path: string, removed: Set<string>, top: boolean): void {
  if (isRecord(input) && isRecord(output)) {
    for (const key of Object.keys(input)) {
      if (!Object.prototype.hasOwnProperty.call(output, key)) {
        if (dropped(input, key)) removed.add(join(path, key));
      } else diff(toJson(input[key], key), output[key], join(path, key), removed, false);
    }
  } else if (Array.isArray(input) && Array.isArray(output)) {
    let j = 0;
    input.forEach((e, i) => {
      const v = toJson(e, String(i)) ?? null;
      const scalar = v === null || typeof v !== 'object';
      const kept = output[j];
      if (top || !scalar) {
        diff(v, kept, path, removed, top);
        j++;
      } else if (j < output.length && (kept === null || typeof kept !== 'object')) j++;
      else removed.add(path);
    });
  }
}

/**
 * Keeps the fields of `data` that `decision.fields[mode]` allows (field globs, `filterObject`
 * semantics: values come back JSON-shaped, `toJSON` first, so a model gives the record its
 * `toJSON()` returns). An array is a list of records: each element is filtered on its own and paths
 * do not name the index. `removed` lists the dropped paths in code-unit order, a subtree dropped
 * whole as one path. A denied decision keeps nothing: `{}` for a record, `[]` for an array,
 * `undefined` for any other value but `null`.
 */
export function filterFields<T>(decision: Decision, data: T, mode: 'read' | 'write'): { data: Partial<T>; removed: string[] } {
  if (mode !== 'read' && mode !== 'write') throw new AuthzConfigError(`authz-orm: filterFields mode must be 'read' or 'write', got ${JSON.stringify(mode)}`);
  const removed = new Set<string>();
  const input = toJson(data, '');
  if (decision.allowed !== true) {
    dropAll(input, '', removed);
    const none = Array.isArray(input) ? [] : isRecord(input) ? {} : input === null ? null : undefined;
    return { data: none as Partial<T>, removed: [...removed].sort() };
  }
  const out = filterObject(decision.fields[mode], data) as Partial<T>;
  diff(input, out, '', removed, true);
  return { data: out, removed: [...removed].sort() };
}
