import { isJson, type Json } from './refs.js';

/**
 * ajv-merge-patch's `$merge` (RFC 7396 JSON Merge Patch) and `$patch` (RFC 6902 JSON Patch), resolved at generation
 * time: `{ source, with }`, where `source` and a `$merge`'s `with` may be a `$ref`. The result stands in for the keyword
 * and is validated next to the node's other keywords, as the macro's is.
 */
export type Resolved = { schema: unknown } | { error: string };

const clone = (value: unknown): unknown => (value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown));

/** RFC 7396, in place for objects, as json-merge-patch's `apply`. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isJson(patch)) return clone(patch);
  const result: Json = isJson(target) ? target : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else Object.defineProperty(result, key, { value: mergePatch(result[key], value), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

const unescape = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');

function locate(document: unknown, pointer: string): { parent: unknown; key: string } {
  if (!pointer.startsWith('/')) throw new Error(`'${pointer}' is not a JSON pointer below the root`);
  const segments = pointer.slice(1).split('/').map(unescape);
  let parent = document;
  for (const segment of segments.slice(0, -1)) {
    if (!isJson(parent) && !Array.isArray(parent)) throw new Error(`'${pointer}' does not exist`);
    parent = (parent as Record<string, unknown>)[segment];
  }
  if (!isJson(parent) && !Array.isArray(parent)) throw new Error(`'${pointer}' does not exist`);
  return { parent, key: segments[segments.length - 1] };
}

function read(document: unknown, pointer: string): unknown {
  const { parent, key } = locate(document, pointer);
  if (!Object.hasOwn(parent as object, key)) throw new Error(`'${pointer}' does not exist`);
  return (parent as Record<string, unknown>)[key];
}

function remove(document: unknown, pointer: string): void {
  const { parent, key } = locate(document, pointer);
  if (!Object.hasOwn(parent as object, key)) throw new Error(`'${pointer}' does not exist`);
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete (parent as Json)[key];
}

function add(document: unknown, pointer: string, value: unknown): void {
  const { parent, key } = locate(document, pointer);
  if (!Array.isArray(parent)) {
    Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true });
    return;
  }
  const index = key === '-' ? parent.length : Number(key);
  if (!/^(0|[1-9][0-9]*|-)$/.test(key) || index > parent.length) throw new Error(`'${pointer}' is not an index of the array`);
  parent.splice(index, 0, value);
}

/** RFC 6902, on a copy; a root-level operation is refused, since ajv-merge-patch keeps the original root. */
function jsonPatch(document: unknown, operations: unknown): unknown {
  if (!Array.isArray(operations)) throw new Error("'with' must be an array of operations");
  for (const op of operations) {
    if (!isJson(op) || typeof op.path !== 'string') throw new Error('an operation needs a path');
    const { path } = op;
    if (op.op === 'add') add(document, path, clone(op.value));
    else if (op.op === 'remove') remove(document, path);
    else if (op.op === 'replace') {
      remove(document, path);
      add(document, path, clone(op.value));
    } else if ((op.op === 'move' || op.op === 'copy') && typeof op.from === 'string') {
      const value = clone(read(document, op.from));
      if (op.op === 'move') remove(document, op.from);
      add(document, path, value);
    } else if (op.op === 'test') {
      if (JSON.stringify(read(document, path)) !== JSON.stringify(op.value)) throw new Error(`test of '${path}' fails`);
    } else throw new Error(`operation ${JSON.stringify(op.op)} is not a JSON Patch operation`);
  }
  return document;
}

/** Resolves `$merge` or `$patch` of `schema`; `target` looks a `$ref` up, as the schema the server registered. */
export function resolveMergePatch(keyword: '$merge' | '$patch', value: unknown, target: (ref: string) => unknown): Resolved {
  if (!isJson(value) || !('source' in value) || !('with' in value)) return { error: `'${keyword}' needs a source and a with` };
  const resolve = (part: unknown): unknown => (isJson(part) && typeof part.$ref === 'string' ? target(part.$ref) : part);
  const source = clone(resolve(value.source));
  const patch = keyword === '$merge' ? resolve(value.with) : value.with;
  if (source === undefined || patch === undefined) return { error: `'${keyword}' references a schema that is not in the manifest` };
  if (!isJson(source)) return { schema: source };
  try {
    return { schema: keyword === '$merge' ? mergePatch(source, patch) : jsonPatch(source, patch) };
  } catch (error) {
    return { error: `'${keyword}' cannot be applied: ${(error as Error).message}` };
  }
}
