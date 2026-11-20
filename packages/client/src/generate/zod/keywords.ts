import { literal } from '../ts-type.js';
import { child, type Location } from './diagnostics.js';
import { objectKey, use, type Check, type ZodNode } from './print.js';
import { isJson, type Json } from './refs.js';

/** What the keyword mappings need from the schema builder, bound to the node being built. */
export interface KeywordHost {
  at: Location;
  variant: 'request' | 'reply' | 'coerced';
  /** Inside a `not` or the `if` of a conditional, where Ajv stops at the first failure. */
  short: boolean;
  /** The node is validated once per item or key by its parent. */
  loop: 'lax' | 'strict' | 'none';
  /** Whether a `contains` can run inside `schema` on the same variable as its parent loop (see `emptyFirst`). */
  reachesContains(schema: unknown): boolean;
  /** Runs `build`, and tells whether a replay or a node it built was cut (ZOD005): a test that was cut cannot be read. */
  cutIn<T>(build: () => T): { value: T; cut: boolean };
  /** Says (ZOD005) that the keyword at `at` is left unchecked because what it reads accepts more than the server does. */
  leftUnchecked(at: Location): void;
  /** The schema a check reads: a reference, a hoisted const, or the schema inline inside a getter. */
  subject(schema: unknown, at: Location, options?: { rooted?: boolean; short?: boolean; loop?: 'lax' | 'strict' | 'none' }): ZodNode;
  /** A `@spinajs/client/formats` export, imported on use. */
  format(name: string): string;
  /** What Ajv's coercions leave of the value after the `if` of `schema` ran, as a function, and the schemas it reads; absent where none runs. */
  afterIf(schema: Json): { fn: string; uses: ZodNode[]; cut?: boolean } | undefined;
  /** The same for the object keywords that run before `patternProperties`. */
  afterObject(schema: Json): { fn: string; uses: ZodNode[]; cut?: boolean } | undefined;
  /** The same for the items keywords that run before `contains`. */
  afterItems(schema: Json): { fn: string; uses: ZodNode[]; cut?: boolean } | undefined;
  unmapped(at: Location, message: string): void;
}

const accepts = (i: number): string => `(v) => ${use(i)}.safeParse(v).success`;

/** `not`, `if`/`then`/`else` and the object keywords. Each passes a value of a type it does not apply to, as in Ajv. */
export function inputChecks(schema: Json, host: KeywordHost): Check[] {
  return [...negation(schema, host), ...conditional(schema, host), ...counts(schema, host), ...names(schema, host), ...dependencies(schema, host), ...patterns(schema, host), ...emptyFirstKeys(schema, host)];
}

function negation(schema: Json, host: KeywordHost): Check[] {
  if (!('not' in schema)) return [];
  const inner = host.cutIn(() => host.subject(schema.not, child(host.at, 'not'), { short: true, loop: host.loop === 'lax' ? 'strict' : host.loop === 'strict' ? 'lax' : undefined }));
  if (inner.cut) {
    host.leftUnchecked(child(host.at, 'not'));
    return [];
  }
  return [{ kind: 'refine', fn: `(v) => !${use(0)}.safeParse(v).success`, uses: [inner.value], message: 'must NOT be valid' }];
}

// Ajv ignores `then` and `else` without `if`, and `if` without either.
function conditional(schema: Json, host: KeywordHost): Check[] {
  if (!('if' in schema) || !('then' in schema || 'else' in schema)) return [];
  // The then and the else read the value as the coercions inside the if left it.
  const after = host.afterIf(schema);
  if (after?.cut) return [];
  const base = after?.uses.length ?? 0;
  const { value: test, cut } = host.cutIn(() => host.subject(schema.if, child(host.at, 'if'), { short: true }));
  if (cut) {
    host.leftUnchecked(child(host.at, 'if'));
    return [];
  }
  const branch = (key: 'then' | 'else'): Check[] => {
    if (!(key in schema)) return [];
    const uses = [...(after?.uses ?? []), test, host.subject(schema[key], child(host.at, key))];
    // Whether the if held is decided on the value it was given; only the branch reads what its coercions left.
    const verdict = (arg: string): string => `${key === 'then' ? '!' : ''}${use(base)}.safeParse(v).success || ${use(base + 1)}.safeParse(${arg}).success`;
    const fn = after ? `((after) => (v) => { const w = after(v); return ${verdict('w')}; })(${after.fn})` : `(v) => ${verdict('v')}`;
    return [{ kind: 'refine', fn, uses, message: `must match "${key}" schema` }];
  };
  return [...branch('then'), ...branch('else')];
}

function counts(schema: Json, host: KeywordHost): Check[] {
  const checks: Check[] = [];
  for (const [key, word] of [['minProperties', 'fewer'], ['maxProperties', 'more']] as const) {
    const n = schema[key];
    if (typeof n === 'number') checks.push({ kind: 'refine', fn: `${host.format(key)}(${n})`, message: `must NOT have ${word} than ${n} properties` });
  }
  return checks;
}

function names(schema: Json, host: KeywordHost): Check[] {
  if (!('propertyNames' in schema)) return [];
  const uses = [host.subject(schema.propertyNames, child(host.at, 'propertyNames'), { rooted: true, loop: 'none' })];
  return [{ kind: 'refine', fn: `${host.format('propertyNames')}(${accepts(0)})`, uses, message: 'property name must be valid' }];
}

function dependencies(schema: Json, host: KeywordHost): Check[] {
  if (!isJson(schema.dependencies)) return [];
  const uses: ZodNode[] = [];
  const entries = Object.entries(schema.dependencies).map(([key, dependency]) => {
    if (Array.isArray(dependency)) return `${objectKey(key)}: ${JSON.stringify(dependency)}`;
    uses.push(host.subject(dependency, child(host.at, 'dependencies', key), { loop: 'none' }));
    return `${objectKey(key)}: ${accepts(uses.length - 1)}`;
  });
  if (entries.length === 0) return [];
  return [{ kind: 'refine', fn: `${host.format('dependencies')}({ ${entries.join(', ')} })`, uses, message: 'must match the dependencies of its present properties' }];
}

const pattern = (source: string): string => `new RegExp(${literal(source)}, 'u')`;

/** `fn`, which reads the schemas at `use(i)`, reading `shift` schemas further on. */
const shifted = (fn: string, shift: number): string => fn.replace(/\ue000(\d+)\ue001/g, (_m, i: string) => use(Number(i) + shift));

/** `check` (a function of the value) applied to the value as `after` leaves it; the schemas of `after` follow those of `check`. */
function readAfter(check: Check, after: { fn: string; uses: ZodNode[] } | undefined): Check {
  if (!after || check.kind !== 'refine') return check;
  const own = check.uses?.length ?? 0;
  return { ...check, fn: `((after, check) => (v) => check(after(v)))(${shifted(after.fn, own)}, ${check.fn})`, uses: [...(check.uses ?? []), ...after.uses] };
}

// zod's catchall cannot tell keys apart, so the object stays open with a typed catchall and these checks decide.
// Ajv runs them after `additionalProperties`, `dependencies` and `properties`, so they read what those coerced.
function patterns(schema: Json, host: KeywordHost): Check[] {
  if (!isJson(schema.patternProperties)) return [];
  const after = host.afterObject(schema);
  // The replay it needs was cut (ZOD005): the patterns are left unchecked.
  if (after?.cut) {
    host.leftUnchecked(child(host.at, 'patternProperties'));
    return [];
  }
  const sources = Object.keys(schema.patternProperties);
  const uses = Object.entries(schema.patternProperties).map(([source, value]) => host.subject(value, child(host.at, 'patternProperties', source), { rooted: false, loop: 'lax' }));
  const list = sources.map((source, i) => `[${pattern(source)}, ${accepts(i)}]`).join(', ');
  const checks: Check[] = [{ kind: 'refine', fn: `${host.format('patternProperties')}([${list}])`, uses, message: 'must match the schema of each matching pattern property' }];
  const additional = schema.additionalProperties;
  // A reply accepts keys the server adds later, as a lenient object does.
  if ((additional !== false && !isJson(additional)) || host.variant === 'reply') return checks.map((c) => readAfter(c, after));
  const declared = JSON.stringify(Object.keys(isJson(schema.properties) ? schema.properties : {}));
  const regexes = `[${sources.map(pattern).join(', ')}]`;
  const extra = additional === false ? [] : [host.subject(additional, child(host.at, 'additionalProperties'), { rooted: false, loop: 'lax' })];
  const fn = `${host.format('additionalProperties')}(${declared}, ${regexes}${extra.length ? `, ${accepts(0)}` : ''})`;
  return [...checks, { kind: 'refine', fn, uses: extra, message: 'must NOT have additional properties', closes: additional === false } as Check].map((c) => readAfter(c, after));
}

// Ajv gives a `contains` the verdict of the iteration before, so a looped node that reaches one accepts an empty array unless
// it comes first (the nodes are built to pass it: see `arrayChecks`). The first value of the loop is judged by the same node
// built the way Ajv sees it on the first iteration. Ajv loops over the keys `additionalProperties` applies to, and over
// those each pattern matches, in order.
function emptyFirst(value: unknown, at: Location, host: KeywordHost, pick: string): Check[] {
  if (!host.reachesContains(value)) return [];
  const strict = host.subject(value, at, { rooted: false, loop: 'none' });
  const fn = `((first) => (o) => typeof o !== 'object' || o === null || Array.isArray(o) || ((k) => k === undefined || first(Reflect.get(o, k)))(Object.keys(o).find((k) => ${pick})))(${accepts(0)})`;
  return [{ kind: 'refine', fn, uses: [strict], message: 'must match the schema of additional properties', onInput: true }];
}

function emptyFirstKeys(schema: Json, host: KeywordHost): Check[] {
  const patterns = isJson(schema.patternProperties) ? Object.entries(schema.patternProperties) : [];
  const checks = patterns.flatMap(([source, value]) => emptyFirst(value, child(host.at, 'patternProperties', source), host, `${pattern(source)}.test(k)`));
  const declared = JSON.stringify(Object.keys(isJson(schema.properties) ? schema.properties : {}));
  const additional = emptyFirst(schema.additionalProperties, child(host.at, 'additionalProperties'), host, `!${declared}.includes(k) && ![${patterns.map(([source]) => pattern(source)).join(', ')}].some((r) => r.test(k))`);
  return [...checks, ...additional];
}

const SCALAR_TYPES = ['number', 'integer', 'string', 'boolean', 'null'];

/** `contains` and ajv-keywords' `uniqueItemProperties`: checks of the parsed array. */
export function arrayChecks(schema: Json, host: KeywordHost): Check[] {
  return [...containsChecks(schema, host), ...uniqueItemPropertiesChecks(schema, host)];
}

function containsChecks(schema: Json, host: KeywordHost): Check[] {
  const checks: Check[] = [];
  const rest = Array.isArray(schema.items) ? schema.additionalItems : schema.items;
  if (host.reachesContains(rest)) {
    const from = Array.isArray(schema.items) ? schema.items.length : 0;
    const strict = host.subject(rest, child(host.at, Array.isArray(schema.items) ? 'additionalItems' : 'items'), { rooted: false, loop: 'none' });
    checks.push({ kind: 'refine', fn: `((first) => (a) => !Array.isArray(a) || a.length <= ${from} || first(a[${from}]))(${accepts(0)})`, uses: [strict], message: 'must match the schema of each item', onInput: true });
  }
  if (!('contains' in schema)) return checks;
  const after = host.afterItems(schema);
  if (after?.cut) {
    host.leftUnchecked(child(host.at, 'contains'));
    return checks;
  }
  const uses = [host.subject(schema.contains, child(host.at, 'contains'), { rooted: false, loop: 'none' })];
  // Ajv lets an empty array pass `contains` when the node validated an item before it as valid: in a not or an if next to
  // a tuple `items`, and as the item or the value of a key, which keep the verdict of the one before.
  const held = `${host.format('contains')}(${accepts(0)})`;
  const lax = host.loop === 'lax' || (host.short && Array.isArray(schema.items) && schema.items.length > 0);
  const fn = lax ? `((held) => (a) => a.length === 0 || held(a))(${held})` : held;
  // Read as sent, the value is not known to be an array.
  const guarded = after ? `((contains) => (a) => !Array.isArray(a) || contains(a))(${fn})` : fn;
  return [{ ...readAfter({ kind: 'refine', fn: guarded, uses, message: 'must contain at least 1 valid item(s)' }, after), ...(after ? { onInput: true } : {}) }, ...checks];
}

function uniqueItemPropertiesChecks(schema: Json, host: KeywordHost): Check[] {
  const keys = schema.uniqueItemProperties;
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) return [];
  // As ajv-keywords reads it: the type the `items` schema declares for the property.
  const properties = isJson(schema.items) && isJson(schema.items.properties) ? schema.items.properties : {};
  const scalar = keys.map((key) => {
    const type = isJson(properties[key]) ? properties[key].type : undefined;
    return Array.isArray(type) ? !type.includes('object') && !type.includes('array') : SCALAR_TYPES.includes(type as string);
  });
  const fn = `${host.format('uniqueItemProperties')}(${JSON.stringify(keys)}, ${JSON.stringify(scalar)})`;
  return [{ kind: 'refine', fn, message: `must NOT have duplicate items by ${keys.join(', ')}` }];
}

/** ajv-keywords' `range` and `exclusiveRange`, macros for the draft-07 limits. */
export function rangeChecks(schema: Json, host: KeywordHost): Check[] {
  const checks: Check[] = [];
  for (const [key, low, high] of [['range', 'gte', 'lte'], ['exclusiveRange', 'gt', 'lt']] as const) {
    const value = schema[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n)) && value[0] <= value[1]) {
      checks.push({ kind: low, value: value[0] as number }, { kind: high, value: value[1] as number });
    } else host.unmapped(child(host.at, key), `'${key}' must be two ascending numbers; it is dropped`);
  }
  return checks;
}

const TRANSFORMS: Record<string, string> = {
  trim: '.trim()',
  trimStart: '.trimStart()',
  trimLeft: '.trimStart()',
  trimEnd: '.trimEnd()',
  trimRight: '.trimEnd()',
  toLowerCase: '.toLowerCase()',
  toUpperCase: '.toUpperCase()',
};

/**
 * ajv-keywords' `transform`, as a function the value goes through before the node's other keywords, which see the
 * result (it runs before `enum` and the string group). `toEnumCase` maps to the `enum` value of the same lower case.
 */
export function transform(schema: Json, host: KeywordHost): string | undefined {
  const steps = schema.transform;
  if (steps === undefined) return undefined;
  if (!Array.isArray(steps) || steps.some((s) => typeof s !== 'string' || !(s in TRANSFORMS || s === 'toEnumCase'))) {
    host.unmapped(child(host.at, 'transform'), "'transform' names an unknown transformation and is dropped");
    return undefined;
  }
  const values = Array.isArray(schema.enum) ? schema.enum.filter((v): v is string => typeof v === 'string') : [];
  const cases = `new Map(${JSON.stringify(values.map((v) => [v.toLowerCase(), v]))})`;
  const expression = (steps as string[]).reduce((s, step) => (step === 'toEnumCase' ? `((t) => ${cases}.get(t.toLowerCase()) || t)(${s})` : `${s}${TRANSFORMS[step]}`), 's');
  return `(s) => (typeof s === 'string' ? ${expression} : s)`;
}

/** ajv-keywords' `regexp`, compiled without the `u` flag, as ajv-keywords does. One with flags is dropped. */
export function regexpCheck(schema: Json, host: KeywordHost): Check[] {
  const value = schema.regexp;
  if (value === undefined) return [];
  const parsed = typeof value === 'string' ? /^\/(.*)\/([gimuy]*)$/s.exec(value) : undefined;
  const source = parsed ? parsed[1] : isJson(value) && typeof value.pattern === 'string' ? value.pattern : undefined;
  const flags = parsed ? parsed[2] : isJson(value) && typeof value.flags === 'string' ? value.flags : '';
  if (source === undefined || flags !== '') {
    host.unmapped(child(host.at, 'regexp'), "'regexp' with flags is not mapped and is dropped; the schema accepts more than the server");
    return [];
  }
  try {
    return new RegExp(source) instanceof RegExp ? [{ kind: 'regex', source, flags: '' }] : [];
  } catch {
    return [];
  }
}
