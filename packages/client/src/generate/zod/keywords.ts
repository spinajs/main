import { literal } from '../ts-type.js';
import { child, type Location } from './diagnostics.js';
import { objectKey, use, type Check, type ZodNode } from './print.js';
import { isJson, type Json } from './refs.js';

/** What the keyword mappings need from the schema builder, bound to the node being built. */
export interface KeywordHost {
  at: Location;
  variant: 'request' | 'reply' | 'coerced';
  /** The schema a check reads: a reference, a hoisted const, or the schema inline inside a getter. */
  subject(schema: unknown, at: Location): ZodNode;
  /** A `@spinajs/client/formats` export, imported on use. */
  format(name: string): string;
  unmapped(at: Location, message: string): void;
}

const accepts = (i: number): string => `(v) => ${use(i)}.safeParse(v).success`;

/** `not`, `if`/`then`/`else` and the object keywords. Each passes a value of a type it does not apply to, as in Ajv. */
export function inputChecks(schema: Json, host: KeywordHost): Check[] {
  return [...negation(schema, host), ...conditional(schema, host), ...counts(schema, host), ...names(schema, host), ...dependencies(schema, host), ...patterns(schema, host)];
}

function negation(schema: Json, host: KeywordHost): Check[] {
  if (!('not' in schema)) return [];
  return [{ kind: 'refine', fn: `(v) => !${use(0)}.safeParse(v).success`, uses: [host.subject(schema.not, child(host.at, 'not'))], message: 'must NOT be valid' }];
}

// Ajv ignores `then` and `else` without `if`, and `if` without either.
function conditional(schema: Json, host: KeywordHost): Check[] {
  if (!('if' in schema) || !('then' in schema || 'else' in schema)) return [];
  const test = host.subject(schema.if, child(host.at, 'if'));
  const branch = (key: 'then' | 'else'): Check[] => {
    if (!(key in schema)) return [];
    const fn = `(v) => ${key === 'then' ? '!' : ''}${use(0)}.safeParse(v).success || ${use(1)}.safeParse(v).success`;
    return [{ kind: 'refine', fn, uses: [test, host.subject(schema[key], child(host.at, key))], message: `must match "${key}" schema` }];
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
  const uses = [host.subject(schema.propertyNames, child(host.at, 'propertyNames'))];
  return [{ kind: 'refine', fn: `${host.format('propertyNames')}(${accepts(0)})`, uses, message: 'property name must be valid' }];
}

function dependencies(schema: Json, host: KeywordHost): Check[] {
  if (!isJson(schema.dependencies)) return [];
  const uses: ZodNode[] = [];
  const entries = Object.entries(schema.dependencies).map(([key, dependency]) => {
    if (Array.isArray(dependency)) return `${objectKey(key)}: ${JSON.stringify(dependency)}`;
    uses.push(host.subject(dependency, child(host.at, 'dependencies', key)));
    return `${objectKey(key)}: ${accepts(uses.length - 1)}`;
  });
  if (entries.length === 0) return [];
  return [{ kind: 'refine', fn: `${host.format('dependencies')}({ ${entries.join(', ')} })`, uses, message: 'must match the dependencies of its present properties' }];
}

const pattern = (source: string): string => `new RegExp(${literal(source)}, 'u')`;

// zod's catchall cannot tell keys apart, so the object stays open with a typed catchall and these checks decide.
function patterns(schema: Json, host: KeywordHost): Check[] {
  if (!isJson(schema.patternProperties)) return [];
  const sources = Object.keys(schema.patternProperties);
  const uses = Object.entries(schema.patternProperties).map(([source, value]) => host.subject(value, child(host.at, 'patternProperties', source)));
  const list = sources.map((source, i) => `[${pattern(source)}, ${accepts(i)}]`).join(', ');
  const checks: Check[] = [{ kind: 'refine', fn: `${host.format('patternProperties')}([${list}])`, uses, message: 'must match the schema of each matching pattern property' }];
  const additional = schema.additionalProperties;
  // A reply accepts keys the server adds later, as a lenient object does.
  if ((additional !== false && !isJson(additional)) || host.variant === 'reply') return checks;
  const declared = JSON.stringify(Object.keys(isJson(schema.properties) ? schema.properties : {}));
  const regexes = `[${sources.map(pattern).join(', ')}]`;
  const extra = additional === false ? [] : [host.subject(additional, child(host.at, 'additionalProperties'))];
  const fn = `${host.format('additionalProperties')}(${declared}, ${regexes}${extra.length ? `, ${accepts(0)}` : ''})`;
  return [...checks, { kind: 'refine', fn, uses: extra, message: 'must NOT have additional properties', closes: additional === false }];
}

const SCALAR_TYPES = ['number', 'integer', 'string', 'boolean', 'null'];

/** `contains` and ajv-keywords' `uniqueItemProperties`: checks of the parsed array. */
export function arrayChecks(schema: Json, host: KeywordHost): Check[] {
  const checks: Check[] = [];
  if ('contains' in schema) {
    const uses = [host.subject(schema.contains, child(host.at, 'contains'))];
    checks.push({ kind: 'refine', fn: `${host.format('contains')}(${accepts(0)})`, uses, message: 'must contain at least 1 valid item(s)' });
  }
  const keys = schema.uniqueItemProperties;
  if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) {
    // As ajv-keywords reads it: the type the `items` schema declares for the property.
    const properties = isJson(schema.items) && isJson(schema.items.properties) ? schema.items.properties : {};
    const scalar = keys.map((key) => {
      const type = isJson(properties[key]) ? properties[key].type : undefined;
      return Array.isArray(type) ? !type.includes('object') && !type.includes('array') : SCALAR_TYPES.includes(type as string);
    });
    const fn = `${host.format('uniqueItemProperties')}(${JSON.stringify(keys)}, ${JSON.stringify(scalar)})`;
    checks.push({ kind: 'refine', fn, message: `must NOT have duplicate items by ${keys.join(', ')}` });
  }
  return checks;
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
