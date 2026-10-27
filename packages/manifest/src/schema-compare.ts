import { canonicalize } from './hash.js';

type Schema = Record<string, unknown>;
type SchemaMap = Record<string, unknown>;

/** `request`: the client sends the value, `response`: the client reads it. Compatibility rules are mirrored. */
export type Direction = 'request' | 'response';

export interface Finding {
  breaking: boolean;
  detail: string;
}

interface Walk {
  direction: Direction;
  baseSchemas: SchemaMap;
  headSchemas: SchemaMap;
  seen: Set<string>;
  out: Finding[];
}

const isSchema = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const props = (s: Schema): Schema => (isSchema(s.properties) ? s.properties : {});

function resolve(s: Schema, schemas: SchemaMap): Schema | undefined {
  let current = s;
  for (let hops = 0; typeof current.$ref === 'string'; hops++) {
    const next = schemas[current.$ref];
    if (!isSchema(next) || hops > 32) return undefined;
    current = next;
  }
  return current;
}

function report(w: Walk, breaking: boolean, path: string, what: string): void {
  w.out.push({ breaking, detail: `${path} ${what}` });
}

function compareRequired(b: Schema, h: Schema, path: string, w: Walk): void {
  const before = strings(b.required);
  const after = strings(h.required);
  const stillThere = new Set(Object.keys(props(h)));

  for (const name of after.filter((n) => !before.includes(n))) {
    if (w.direction === 'request') report(w, true, `${path}.${name}`, 'is now required');
  }
  for (const name of before.filter((n) => !after.includes(n) && stillThere.has(n))) {
    report(w, w.direction === 'response', `${path}.${name}`, 'is no longer required');
  }
}

function compareProperties(b: Schema, h: Schema, path: string, w: Walk): void {
  const before = props(b);
  const after = props(h);

  for (const name of Object.keys(before)) {
    const next = after[name];
    if (next === undefined) report(w, w.direction === 'response', `${path}.${name}`, 'property removed');
    else walk(before[name], next, `${path}.${name}`, w);
  }
  for (const name of Object.keys(after).filter((n) => !(n in before))) report(w, false, `${path}.${name}`, 'property added');
}

function compareEnum(b: Schema, h: Schema, path: string, w: Walk): void {
  if (!Array.isArray(b.enum) || !Array.isArray(h.enum)) return;
  const [from, to] = w.direction === 'request' ? [b.enum, h.enum] : [h.enum, b.enum];
  const fromKeys = new Set(from.map((v) => canonicalize(v)));
  const lost = to.filter((v) => !fromKeys.has(canonicalize(v)));
  if (lost.length > 0) report(w, true, path, w.direction === 'request' ? 'enum value removed' : 'enum value added');
}

function compareUnion(b: Schema, h: Schema, path: string, w: Walk): void {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const before = b[key];
    const after = h[key];
    if (!Array.isArray(before) || !Array.isArray(after)) continue;

    const shared = Math.min(before.length, after.length);
    for (let i = 0; i < shared; i++) walk(before[i], after[i], `${path}|${i}`, w);
    if (after.length < before.length && w.direction === 'response') report(w, true, path, `${key} member removed`);
    if (after.length > before.length && w.direction === 'request') report(w, true, path, `${key} member added`);
  }
}

function walk(base: unknown, head: unknown, path: string, w: Walk): void {
  if (!isSchema(base) || !isSchema(head)) return;

  if (base.$ref !== undefined || head.$ref !== undefined) {
    const pair = `${String(base.$ref)}|${String(head.$ref)}`;
    if (w.seen.has(pair)) return;
    w.seen.add(pair);
  }

  const b = resolve(base, w.baseSchemas);
  const h = resolve(head, w.headSchemas);
  if (!b || !h) return;

  if (canonicalize(b.type) !== canonicalize(h.type)) {
    report(w, true, path, `type changed from ${canonicalize(b.type)} to ${canonicalize(h.type)}`);
    return;
  }

  compareProperties(b, h, path, w);
  compareRequired(b, h, path, w);
  compareEnum(b, h, path, w);
  compareUnion(b, h, path, w);
  walk(b.items, h.items, `${path}[]`, w);
}

/** Structural compatibility findings between two schema trees addressed by `$id`. */
export function compareSchemaRefs(baseId: string, headId: string, direction: Direction, baseSchemas: SchemaMap, headSchemas: SchemaMap, label: string): Finding[] {
  const w: Walk = { direction, baseSchemas, headSchemas, seen: new Set(), out: [] };
  walk({ $ref: baseId }, { $ref: headId }, label, w);
  return w.out;
}
