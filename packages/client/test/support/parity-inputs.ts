import fc from 'fast-check';
import type { Manifest } from '@spinajs/manifest';

type Json = Record<string, unknown>;
type Random = () => number;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const own = (o: Json, key: string, value: unknown): void => void Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });

const STRINGS = ['', 'a', 'ab', 'abc', 'abcd', 'A', 'AB', ' ab ', ' AB ', 'é', '\u{1F600}', '\u{1F600}\u{1F600}', '\u{1F600}\u{1F600}\u{1F600}\u{1F600}', '\uD800', 'x@y.co', 'a@b', '2020-01-01', '2020-02-29', '2021-02-29', '2020-02-30',
  '2020-01-01T00:00:00', '2020-01-01T00:00:00Z', '2020-01-01 00:00:00+02:00', '12:00:00', '12:00:00Z', 'http://a.b/c', '00000000-0000-0000-0000-000000000000', '1.5', '-5', '5', '0', '1', '2', 'true', 'false', 'TRUE',
  'null', '__proto__', 'constructor', 'toString', 'x1', 'xa', 'n1', '1.2.3.4', 'a.b', '[', '^a$', '12', '-0', 'b', 'k', 'x', 'main', 'Infinity', '-Infinity', '1e400', 'NaN', ' 5 ', '0x10', 'abc', 'cd', 'ABC', 'def', 'aa'];

const NUMBERS = [0, -0, 1, 2, 2.5, 3, 4, 5, 6, -1, 0.3, 0.5, 0.1, 18, 100, 101, 129.9, 130, 1e21, 2 ** 31, 2 ** 53 + 2, 1.5];

const WIRE = ['', '0', 0, false, '1', null, 'true', ['1'], '5', '12', ['1', 1], ['5', '5'], [true], ['7', '7'], '-1', 'false', [], ['a']];

/**
 * Non-finite numbers, as code can build them (JSON cannot carry them, and the client serializes them to null). The fixed
 * server refuses one wherever it sits, which zod does only where the schema types a number, or in an intersection.
 * They are compared apart from the other inputs.
 */
export function nonFinite(): unknown[] {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  return [...bad, ...bad.map((v) => [v]), ...bad.map((v) => ({ v })), ...bad.map((v) => ({ a: v, b: v }))];
}

/** Values every schema meets, whatever its type: the empty and null cases, own keys that name prototype members. */
export function generic(): unknown[] {
  return [
    null, true, false, 0, 1, 'a', '', [], [1], ['a'], {}, { a: 1 }, JSON.parse('{"__proto__":1}') as unknown, { toString: 1 }, { valueOf: 1 }, 'Infinity', '1e400', '5', ['5'], 'true',
    ...WIRE.map((v) => ({ v })),
  ];
}

function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives a value from a schema: mostly valid ones with a few typical breaches, as a query string would carry them when `coerce` is set. */
function generator(manifest: Manifest) {
  const schemas: Record<string, unknown> = manifest.schemas;
  const resolve = (ref: string, owner: string): [unknown, string] => {
    if (ref === '#') return [schemas[owner], owner];
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    if (m) return [(schemas[owner] as Json | undefined)?.[m[1]] && ((schemas[owner] as Json)[m[1]] as Json)[m[2]], owner];
    return [schemas[ref], ref];
  };
  const typesOf = (s: Json): string[] => {
    if (typeof s.type === 'string') return [s.type];
    if (Array.isArray(s.type)) return s.type as string[];
    const t: string[] = [];
    if (['minLength', 'maxLength', 'pattern', 'format', 'transform', 'regexp'].some((k) => k in s)) t.push('string');
    if (['minimum', 'maximum', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum', 'format', 'range', 'exclusiveRange'].some((k) => k in s)) t.push('number');
    if (['items', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'uniqueItemProperties'].some((k) => k in s)) t.push('array');
    if (['properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames', 'dependencies', 'minProperties', 'maxProperties'].some((k) => k in s)) t.push('object');
    return t;
  };


  const FORMATS: Record<string, string> = {
    email: 'a@b.co', 'date-time': '2020-01-01T00:00:00Z', date: '2020-01-01', time: '12:00:00Z', uri: 'http://a.b/c', url: 'http://a.b/c', 'uri-reference': '/a', uuid: '00000000-0000-0000-0000-000000000000',
    ipv4: '1.2.3.4', ipv6: '::1', hostname: 'a.b', regex: '^a$', duration: 'P1D', 'json-pointer': '/a', byte: 'YQ==', decimal: '1.5', 'uri-template': '/a{b}',
  };
  const patterns = new Map<string, string[]>();
  const matching = (pattern: string, rnd: Random): string | undefined => {
    let pool = patterns.get(pattern);
    if (!pool) {
      try {
        pool = fc.sample(fc.stringMatching(new RegExp(pattern, 'u')), { seed: hash(pattern), numRuns: 6 });
      } catch {
        pool = [];
      }
      patterns.set(pattern, pool);
    }
    return pool.length ? pool[Math.floor(rnd() * pool.length)] : undefined;
  };

  // RFC 7386 merge patch, and the add, replace and remove of RFC 6902: what `$merge` and `$patch` resolve to.
  const mergePatch = (target: unknown, patch: unknown): unknown => {
    if (!isObj(patch)) return patch;
    const out: Json = isObj(target) ? { ...target } : {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete out[k];
      else out[k] = mergePatch(out[k], v);
    }
    return out;
  };
  const applyPatch = (doc: unknown, ops: unknown): unknown => {
    const out = clone(doc);
    for (const op of Array.isArray(ops) ? ops : []) {
      if (!isObj(op) || typeof op.path !== 'string') continue;
      const tokens = op.path.split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
      let at: unknown = out;
      for (const t of tokens.slice(0, -1)) at = (at as Json | undefined)?.[t];
      const last = tokens[tokens.length - 1];
      if (Array.isArray(at)) {
        if (op.op === 'remove') at.splice(Number(last), 1);
        else if (last === '-') at.push(op.value);
        else if (op.op === 'add') at.splice(Number(last), 0, op.value);
        else at[Number(last)] = op.value;
      } else if (isObj(at)) {
        if (op.op === 'remove') delete at[last];
        else at[last] = op.value;
      }
    }
    return out;
  };
  const merged = (s: Json, owner: string): [unknown, string] | undefined => {
    for (const k of ['$merge', '$patch']) {
      const m = s[k];
      if (!isObj(m)) continue;
      const [source, to] = isObj(m.source) && typeof m.source.$ref === 'string' ? resolve(m.source.$ref, owner) : [m.source, owner];
      return [k === '$merge' ? mergePatch(source, m.with) : applyPatch(source, m.with), to];
    }
    return undefined;
  };

  /** A value the schema accepts, as far as its keywords can be read: the base the accepted inputs are mutated from. */
  const valid = (rnd: Random, s: unknown, owner: string, depth = 0): unknown => {
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
    if (!isObj(s) || depth > 5) return pick([null, 'ab', 1, {}]);
    const m = merged(s, owner);
    if (m) return valid(rnd, m[0], m[1], depth + 1);
    if (typeof s.$ref === 'string') {
      const [target, to] = resolve(s.$ref, owner);
      const v = valid(rnd, target, to, depth + 1);
      return isObj(v) && isObj(s.properties) ? Object.assign(v, valid(rnd, { ...s, $ref: undefined }, owner, depth + 1)) : v;
    }
    if ('const' in s && !(isObj(s.const) && '$data' in s.const)) return clone(s.const);
    if (Array.isArray(s.enum) && s.enum.length) return clone(pick(s.enum as unknown[]));
    if (s.default !== undefined && rnd() < 0.2) return clone(s.default);
    // The allOf members and the node's own keywords make one schema; objects are merged by value.
    let base: unknown;
    if (Array.isArray(s.allOf)) {
      const vs = s.allOf.map((x) => valid(rnd, x, owner, depth + 1));
      const mine = isObj(s.properties) || s.type === 'object' ? valid(rnd, { ...s, allOf: undefined, anyOf: undefined, oneOf: undefined }, owner, depth + 1) : undefined;
      if (vs.every(isObj)) base = Object.assign({}, ...vs, isObj(mine) ? mine : {});
      else {
        const merged: Json = Object.assign({}, ...s.allOf.filter(isObj), { ...s, allOf: undefined });
        if (s.allOf.some((x) => isObj(x) && x.type === 'integer')) merged.type = 'integer';
        return valid(rnd, merged, owner, depth + 1);
      }
    }
    for (const k of ['anyOf', 'oneOf']) {
      if (!Array.isArray(s[k]) || !(s[k] as unknown[]).length) continue;
      const v = valid(rnd, pick(s[k] as unknown[]), owner, depth + 1);
      return isObj(base) && isObj(v) ? Object.assign(base, v) : v;
    }
    if (base !== undefined) return base;
    const t = pick(typesOf(s).length ? typesOf(s) : ['string']);
    switch (t) {
      case 'string': {
        const format = typeof s.format === 'string' ? s.format : undefined;
        const known = format !== undefined && format in FORMATS;
        let text = typeof s.pattern === 'string' ? (matching(s.pattern, rnd) ?? 'ab') : known ? FORMATS[format] : rnd() < 0.5 ? pick(['ab', 'abc', 'xyz', 'Hello', 'a b', 'q1']) : `s${Math.floor(rnd() * 100)}`;
        if (!s.pattern && !known) {
          const min = typeof s.minLength === 'number' ? s.minLength : 0;
          const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
          while ([...text].length < min) text += 'a';
          if ([...text].length > max) text = [...text].slice(0, max).join('');
        }
        return text;
      }
      case 'number':
      case 'integer': {
        const step = typeof s.multipleOf === 'number' && s.multipleOf > 0 ? s.multipleOf : t === 'integer' ? 1 : 0;
        const low = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + (step || 1) : 0;
        let v = step ? Math.ceil(low / step) * step : low;
        if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) v += step || 1;
        // Spread the draws over the accepted range: a fixed value would give a schema with a wide domain few distinct inputs.
        const jitter = (step || (t === 'integer' ? 1 : 0.25)) * Math.floor(rnd() * 30);
        if (rnd() < 0.7 && !(typeof s.maximum === 'number' && v + jitter > s.maximum) && !(typeof s.exclusiveMaximum === 'number' && v + jitter >= s.exclusiveMaximum)) v += jitter;
        if (typeof s.maximum === 'number' && v > s.maximum) v = s.maximum;
        return Number(v.toFixed(6));
      }
      case 'boolean':
        return rnd() < 0.5;
      case 'null':
        return null;
      case 'array': {
        const prefix = Array.isArray(s.items) ? (s.items as unknown[]) : [];
        const min = typeof s.minItems === 'number' ? s.minItems : 0;
        const len = Math.min(Math.max(min, prefix.length, depth >= 2 ? 0 : 1 + Math.floor(rnd() * 2)), typeof s.maxItems === 'number' ? s.maxItems : 5, 6);
        const out: unknown[] = [];
        for (let i = 0; i < len; i++) {
          const sub = i < prefix.length ? prefix[i] : Array.isArray(s.items) ? s.additionalItems : s.items;
          let v = sub === false ? null : valid(rnd, sub ?? true, owner, depth + 1);
          for (let tries = 0; s.uniqueItems === true && tries < 4 && out.some((o) => JSON.stringify(o) === JSON.stringify(v)); tries++) v = valid(rnd, sub ?? true, owner, depth + 1);
          out.push(v);
        }
        if (isObj(s.contains) && out.length) out[Math.floor(rnd() * out.length)] = valid(rnd, s.contains, owner, depth + 1);
        return out;
      }
      default: {
        const o: Json = {};
        const req = Array.isArray(s.required) ? (s.required as string[]) : [];
        const props = isObj(s.properties) ? s.properties : {};
        for (const [k, v] of Object.entries(props)) if (req.includes(k) || rnd() < 0.6) own(o, k, valid(rnd, v, owner, depth + 1));
        for (const k of req) if (!Object.hasOwn(o, k)) own(o, k, valid(rnd, true, owner, depth + 1));
        // A const read from a sibling, `1/name`, is that sibling's value.
        for (const [k, v] of Object.entries(props)) {
          const from = isObj(v) && isObj(v.const) && typeof v.const.$data === 'string' ? /^1\/([^/]+)$/.exec(v.const.$data)?.[1] : undefined;
          if (from !== undefined && Object.hasOwn(o, from)) own(o, k, clone(o[from]));
        }
        if (isObj(s.dependencies)) {
          for (const [k, dependency] of Object.entries(s.dependencies)) {
            if (!(k in o)) continue;
            if (Array.isArray(dependency)) {
              for (const name of dependency as string[]) if (!Object.hasOwn(o, name)) own(o, name, valid(rnd, props[name] ?? true, owner, depth + 1));
            } else Object.assign(o, valid(rnd, dependency, owner, depth + 1) as Json);
          }
        }
        for (let i = 0; Object.keys(o).length < (typeof s.minProperties === 'number' ? s.minProperties : 0); i++) own(o, `k${i}`, 1);
        return o;
      }
    }
  };

  /** Values at and around the limits of a schema: a mutation of one property to its boundary. */
  const edges = (s: unknown, owner: string, rnd: Random): unknown[] => {
    if (!isObj(s)) return [];
    const out: unknown[] = [];
    const text = (n: number): string => 'a'.repeat(Math.max(0, n));
    for (const k of ['minLength', 'maxLength']) if (typeof s[k] === 'number') out.push(text(s[k] - 1), text(s[k]), text(s[k] + 1));
    for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (typeof s[k] === 'number') out.push(s[k] - 1, s[k], s[k] + 1);
    if (typeof s.multipleOf === 'number') out.push(s.multipleOf, s.multipleOf * 3, s.multipleOf / 2);
    const item = Array.isArray(s.items) ? s.items[0] : s.items;
    for (const k of ['minItems', 'maxItems']) {
      if (typeof s[k] === 'number' && s[k] < 30) for (const n of [s[k] - 1, s[k], s[k] + 1]) if (n >= 0) out.push(Array.from({ length: n }, (_, i) => (item === undefined ? i : valid(rnd, item, owner, 1))));
    }
    return out;
  };

  const random = (rnd: Random, id: string, coerce: boolean, from?: unknown): unknown => {
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
    const wire = (v: unknown): unknown => {
      if (!coerce || (v !== null && typeof v === 'object')) return v;
      const r = rnd();
      return r < 0.45 ? String(v) : r < 0.55 ? [v] : r < 0.6 ? [String(v)] : v;
    };
    // A recursive schema would otherwise grow a value with every level: cap the nodes a value may hold.
    let budget = 60;
    const gen = (s: unknown, owner: string, depth: number): unknown => {
      budget--;
      if (s === true || s === undefined) return pick([0, 'x', null, {}, [], true]);
      if (s === false) return 1;
      if (!isObj(s)) return null;
      if (depth > 4) return pick([null, 'x', {}, []]);
      const r = rnd();
      if (typeof s.$ref === 'string' && r < 0.85) {
        const [target, to] = resolve(s.$ref, owner);
        const v = gen(target, to, depth + 1);
        if (isObj(v) && isObj(s.properties)) Object.assign(v, gen({ ...s, $ref: undefined }, owner, depth + 1));
        return v;
      }
      for (const k of ['$merge', '$patch']) {
        const m = s[k];
        if (isObj(m) && r < 0.85) {
          const source = gen(isObj(m.source) && typeof m.source.$ref === 'string' ? resolve(m.source.$ref, owner)[0] : m.source, owner, depth + 1);
          const patch = k === '$merge' ? gen(m.with, owner, depth + 1) : undefined;
          return isObj(source) && isObj(patch) ? Object.assign(source, patch) : source;
        }
      }
      if ('const' in s && !isObj(s.const) && r < 0.8) return wire(clone(s.const));
      if (Array.isArray(s.enum) && r < 0.8) return wire(clone(pick(s.enum as unknown[])));
      for (const k of ['anyOf', 'oneOf']) if (Array.isArray(s[k]) && rnd() < 0.8) return gen(pick(s[k] as unknown[]), owner, depth + 1);
      if (Array.isArray(s.allOf) && rnd() < 0.85) {
        const vs = (s.allOf as unknown[]).map((m) => gen(m, owner, depth + 1));
        const mine = typesOf(s).includes('object') || isObj(s.properties) ? gen({ ...s, allOf: undefined, anyOf: undefined }, owner, depth + 1) : undefined;
        if (vs.every(isObj)) return Object.assign({}, ...vs, isObj(mine) ? mine : {});
        return pick(vs);
      }
      const types = typesOf(s);
      const t = types.length && rnd() < 0.9 ? pick(types) : pick(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);
      switch (t) {
        case 'string':
          return pick(STRINGS);
        case 'number':
          return wire(pick(NUMBERS));
        case 'integer':
          return wire(pick(NUMBERS.filter(Number.isInteger)));
        case 'boolean':
          return wire(rnd() < 0.5);
        case 'null':
          return wire(null);
        case 'array': {
          const prefix = Array.isArray(s.items) ? (s.items as unknown[]) : [];
          const max = typeof s.maxItems === 'number' ? s.maxItems : prefix.length && s.additionalItems === false ? prefix.length : 5;
          const lens = [0, 1, 2, 3, 4, typeof s.minItems === 'number' ? s.minItems : 0, max, max + 1].filter((n) => n >= 0 && n < 30);
          const len = budget < 0 ? 0 : Math.min(pick(lens), Math.max(budget, 1));
          const dup = rnd() < 0.3;
          const out: unknown[] = [];
          for (let i = 0; i < len; i++) {
            const sub = i < prefix.length ? prefix[i] : Array.isArray(s.items) ? s.additionalItems : s.items;
            out.push(dup && i > 0 ? clone(out[0]) : gen(sub, owner, depth + 1));
          }
          return coerce && len === 1 && rnd() < 0.3 ? out[0] : out;
        }
        case 'object': {
          const o: Json = {};
          const props = isObj(s.properties) ? s.properties : {};
          const req = Array.isArray(s.required) ? (s.required as string[]) : [];
          for (const [k, v] of Object.entries(props)) {
            if (req.includes(k) ? rnd() < 0.95 : rnd() < 0.6) own(o, k, gen(v, owner, depth + 1));
          }
          for (const k of req) if (!Object.hasOwn(o, k) && rnd() < 0.8) own(o, k, gen(true, owner, depth + 1));
          if (isObj(s.patternProperties) && rnd() < 0.5) o[pick(['x1', 'xa', 'n1', 'a1', 'é', 'aa', 'ab'])] = gen(pick(Object.values(s.patternProperties)), owner, depth + 1);
          if (rnd() < 0.15) o[pick(['zz', 'x1', 'toString', 'valueOf', 'k', 'y'])] = isObj(s.additionalProperties) ? gen(s.additionalProperties, owner, depth + 1) : pick([1, 'a']);
          // A name list under a key the object holds, an inherited `constructor` included, must be there too.
          if (isObj(s.dependencies)) {
            for (const [k, dependency] of Object.entries(s.dependencies)) {
              if (Array.isArray(dependency) && k in o && rnd() < 0.9) for (const name of dependency as string[]) if (!Object.hasOwn(o, name)) own(o, name, gen(props[name] ?? true, owner, depth + 1));
            }
          }
          if (rnd() < 0.03) own(o, '__proto__', 'p');
          return o;
        }
      }
      return null;
    };
    return gen(from === undefined ? schemas[id] : from, id, 0);
  };

  return { random, valid: (rnd: Random, id: string, from?: unknown): unknown => valid(rnd, from === undefined ? schemas[id] : from, id), edges };
}

const fingerprint = (v: unknown): string => JSON.stringify(v) + (isObj(v) && Object.hasOwn(v, '__proto__') ? 'P' : '');
const hash = (text: string): number => [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

export interface InputOptions {
  /** Draw values as a query, path or header would carry them: scalars as text, sometimes repeated. */
  coerce: boolean;
  /** Schema-derived values to draw. */
  samples: number;
  /** Fixed, so a run repeats exactly; mixed with the schema id so the schemas do not share a stream. */
  seed: number;
  /** The server's verdict. With it, more values are drawn until `floor` of them are accepted, and accepted objects are mutated one property at a time. */
  accepts?: (input: unknown) => boolean;
  floor?: number;
  /** Arbitrary JSON values to add; 100 by default. */
  json?: number;
}

export interface InputSet {
  inputs: unknown[];
  /** The server accepts fewer than `floor` of them, and further draws found no more: the schema has few values to accept. */
  saturated: boolean;
}

const VALID_DRAWS = 40;
const TOP_UP_DRAWS = 600;
const TOP_UP_PATIENCE = 200;
const MAX_BASES = 8;
const MAX_MUTATIONS = 240;

const SALT = { valid: 0x51ed270b, topUp: 0x9e3779b1, mutate: 0x85ebca6b };

/**
 * The inputs for one schema: the generic values, values derived from the schema (random ones, and ones its keywords
 * accept), and arbitrary JSON. Each draw takes a seed from fast-check's seeded sampler, so the same options give the
 * same inputs on any machine.
 *
 * Given the server's verdict, it also tops up the accepted inputs to the floor, and mutates the accepted objects one
 * property at a time (removed, valid, at its limits, random): a keyword of an omnibus schema is then decided by an
 * input whose other properties are valid.
 */
export function drawInputs(manifest: Manifest, id: string, options: InputOptions): InputSet {
  const seed = (options.seed ^ hash(id)) >>> 0;
  const gen = generator(manifest);
  const seen = new Set<string>();
  const derived: unknown[] = [];
  const add = (into: unknown[], v: unknown): boolean => {
    const key = fingerprint(v);
    if (seen.has(key)) return false;
    seen.add(key);
    into.push(v);
    return true;
  };
  const seeds = (salt: number, runs: number): number[] => fc.sample(fc.integer({ min: 0, max: 0x7fffffff }), { seed: (seed ^ salt) >>> 0, numRuns: runs });
  // As a query string carries them: scalars as text, sometimes in an array.
  const wired = (rnd: Random, v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x) => wired(rnd, x));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wired(rnd, x)]));
    const r = rnd();
    return r < 0.4 ? String(v) : r < 0.45 ? [v] : v;
  };

  for (const s of seeds(0, options.samples)) {
    const rnd = mulberry32(s);
    add(derived, gen.random(rnd, id, options.coerce && rnd() < 0.7));
  }
  for (const s of seeds(SALT.valid, VALID_DRAWS)) {
    const rnd = mulberry32(s);
    const v = gen.valid(rnd, id);
    add(derived, options.coerce && rnd() < 0.5 ? wired(rnd, v) : v);
  }
  const json = fc.sample(fc.jsonValue({ maxDepth: 2 }), { seed, numRuns: options.json ?? 100 });
  const inputs = [...generic(), ...derived, ...json];
  const accepts = options.accepts;
  if (!accepts) return { inputs, saturated: false };

  const accepted = new Set(inputs.filter(accepts).map(fingerprint));
  const floor = options.floor ?? 0;
  let saturated = false;
  if (accepted.size < floor) {
    const extra: unknown[] = [];
    let dry = 0;
    for (const s of seeds(SALT.topUp, TOP_UP_DRAWS)) {
      if (dry++ >= TOP_UP_PATIENCE) break;
      const rnd = mulberry32(s);
      const v = rnd() < 0.5 ? gen.random(rnd, id, options.coerce && rnd() < 0.7) : gen.valid(rnd, id);
      if (add(extra, v) && accepts(v)) {
        inputs.push(v);
        accepted.add(fingerprint(v));
        dry = 0;
        if (accepted.size >= floor * 2) break;
      }
    }
    saturated = accepted.size < floor;
  }

  const bases = inputs.filter((v): v is Json => isObj(v) && accepts(v)).slice(0, MAX_BASES);
  const root: unknown = manifest.schemas[id];
  const properties = isObj(root) && isObj(root.properties) ? Object.entries(root.properties).slice(0, 16) : [];
  const rnd = mulberry32((seed ^ SALT.mutate) >>> 0);
  const readersOf = (name: string): string[] => properties.filter(([, s]) => isObj(s) && isObj(s.const) && s.const.$data === `1/${name}`).map(([k]) => k);
  let made = 0;
  for (const base of bases) {
    for (const [name, schema] of properties) {
      const readers = readersOf(name);
      const values: unknown[] = [undefined, gen.valid(rnd, id, schema), ...gen.edges(schema, id, rnd).slice(0, 3), gen.random(rnd, id, options.coerce && rnd() < 0.7, schema)];
      for (const value of values) {
        if (made >= MAX_MUTATIONS) break;
        const mutant = clone(base);
        if (value === undefined) delete mutant[name];
        else own(mutant, name, options.coerce && rnd() < 0.4 ? wired(rnd, value) : value);
        if (add(inputs, mutant)) made++;
        // A sibling whose const reads the property breaks with it; one that follows lets the property's own keywords decide.
        if (value === undefined || readers.length === 0 || made >= MAX_MUTATIONS) continue;
        const paired = clone(mutant);
        for (const reader of readers) own(paired, reader, clone(paired[name]));
        if (add(inputs, paired)) made++;
      }
    }
  }
  return { inputs, saturated };
}

export const inputsFor = (manifest: Manifest, id: string, options: InputOptions): unknown[] => drawInputs(manifest, id, options).inputs;
