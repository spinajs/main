import 'mocha';
import { expect } from 'chai';
import { appBasicManifest } from '../support/fixture.js';
import { diagnosticsFor, parity, parityManifest, serverRefusal, show, subjectOf, zodSchemaOf } from '../support/parity.js';
import { clearLoaded } from '../support/zod.js';

type Json = Record<string, unknown>;
type Random = () => number;

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

const TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'];
const NAMES = ['a', 'b', 'n'];
const SELF = '@self';
const SCALARS: unknown[] = ['Infinity', '-Infinity', '1e400', '5', '0', 'x', '', 5, 0, 1.5, null, true, false, 'true', 'null'];

/** A schema of the shapes that carry a coercion into a branch: combinators, conditionals, children and references. */
function schema(rnd: Random, depth: number): Json {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const leaf = (): Json => {
    const type = pick(TYPES);
    const extra: Json = {};
    if (type === 'number' && rnd() < 0.3) extra.minimum = 0;
    if (type === 'string' && rnd() < 0.3) extra.minLength = 1;
    if (type === 'object' && rnd() < 0.3) extra.minProperties = 2;
    return { type, ...extra };
  };
  if (depth <= 0) return rnd() < 0.15 ? { $ref: pick(['test/FuzzA', 'test/FuzzB']) } : leaf();
  const sub = (): Json => schema(rnd, depth - 1);
  switch (pick(['leaf', 'not', 'anyOf', 'oneOf', 'allOf', 'cond', 'object', 'object', 'array', 'ref', 'itemReader', 'propertyReader', 'itemReader', 'propertyReader'])) {
    case 'not':
      return { ...(rnd() < 0.5 ? { type: pick(TYPES) } : {}), not: sub() };
    case 'anyOf':
      return { ...(rnd() < 0.3 ? { type: pick(TYPES) } : {}), anyOf: [sub(), sub()] };
    case 'oneOf':
      return { oneOf: [sub(), sub()] };
    case 'allOf':
      return { allOf: [sub(), sub()] };
    case 'cond': {
      // Both branches are as likely, and one at least is there: an if without them is not run.
      const then = rnd() < 0.5;
      return { if: sub(), ...(then || rnd() < 0.5 ? { then: sub() } : {}), ...(!then || rnd() < 0.5 ? { else: sub() } : {}) };
    }
    case 'itemReader': {
      // What a keyword that runs after the items reads: the items as a combinator coerced them.
      const item = pick<Json>([{ allOf: [sub(), sub()] }, { anyOf: [sub(), sub()] }, { oneOf: [sub(), sub()] }, { if: sub(), then: sub(), else: sub() }, { allOf: [{ minimum: 1 }, { type: 'number' }] }]);
      return { type: 'array', items: item, ...pick<Json>([{ contains: { const: 5 } }, { contains: sub() }, { uniqueItems: true }, { uniqueItems: true, contains: { type: 'number' } }]) };
    }
    case 'propertyReader': {
      const property = pick<Json>([{ allOf: [sub(), sub()] }, { anyOf: [sub(), sub()] }, { oneOf: [sub(), sub()] }, { if: sub(), then: sub(), else: sub() }, { allOf: [{ minimum: 1 }, { type: 'number' }] }]);
      return {
        type: 'object',
        properties: { a: property, ...(rnd() < 0.5 ? { b: sub() } : {}) },
        ...pick<Json>([
          { patternProperties: { '^a$': { const: 5 } } },
          { patternProperties: { '^[ab]': sub() } },
          { dependencies: { a: sub() } },
          { additionalProperties: sub() },
          { properties: { a: property, c: { type: 'number', minimum: { $data: '1/a' } } } },
        ]),
      };
    }
    case 'object': {
      const properties = Object.fromEntries(NAMES.filter(() => rnd() < 0.7).map((name) => [name, sub()]));
      const extra: Json = {};
      if (rnd() < 0.3) extra.additionalProperties = sub();
      if (rnd() < 0.2) extra.patternProperties = { '^[ab]': sub() };
      if (rnd() < 0.3) extra.required = [pick(NAMES)];
      if (rnd() < 0.2) extra.dependencies = { a: sub() };
      if (rnd() < 0.2) extra.minProperties = 2;
      return { type: 'object', properties, ...extra };
    }
    case 'array':
      return { type: 'array', ...(rnd() < 0.5 ? { items: sub() } : { items: [sub(), sub()], ...(rnd() < 0.5 ? { additionalItems: sub() } : {}) }), ...(rnd() < 0.2 ? { contains: sub() } : {}) };
    case 'ref':
      return { $ref: pick(['test/FuzzA', 'test/FuzzB']) };
    default:
      return leaf();
  }
}

/**
 * A declaration that reaches itself below the object it validates, as a tested value (an if, a not, a union member) or
 * as the items: the value at the reference is a child, so the reference ends, and the declaration is an object so that
 * array coercion does not wrap the same value again. SELF is replaced by the id of the declaration.
 */
function recursive(rnd: Random): Json {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const self: Json = { $ref: SELF };
  const test = pick<Json>([self, { not: self }, { anyOf: [self, schema(rnd, 1)] }, { allOf: [self, schema(rnd, 1)] }]);
  const item: Json = { if: test, then: schema(rnd, 1), else: schema(rnd, 1) };
  const member = pick<Json>([
    item,
    { type: 'array', items: item, ...pick<Json>([{}, { contains: schema(rnd, 1) }, { uniqueItems: true }]) },
    { type: 'array', items: { anyOf: [self, schema(rnd, 1)] }, ...pick<Json>([{ contains: schema(rnd, 1) }, { uniqueItems: true }]) },
  ]);
  return { type: 'object', properties: { [pick(NAMES)]: member }, ...pick<Json>([{}, { patternProperties: { '^[ab]': schema(rnd, 1) } }]) };
}

function value(rnd: Random, depth: number): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const r = rnd();
  if (depth <= 0 || r < 0.5) return pick(SCALARS);
  if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(rnd, depth - 1));
  return Object.fromEntries(NAMES.filter(() => rnd() < 0.7).map((name) => [name, value(rnd, depth - 1)]));
}

const CONTAINS_ITEMS: readonly unknown[] = [[1], [], ['x'], [1, 'x'], ['5'], [0], [[]], 'x', null, ['Infinity'], 1.5, 2, '1.5'];

/** A schema with a `contains` that a loop over items or keys reaches directly, behind a reference, or behind a combinator. */
function loopContains(rnd: Random): Json {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const contains = (): Json => pick<Json>([{ type: 'number' }, { type: 'integer' }, { const: 5 }, { type: 'string' }, { minimum: 1 }]);
  const base = (): Json => ({ type: 'array', contains: contains(), ...(rnd() < 0.2 ? { minItems: 1 } : {}) });
  const reach = (depth: number): Json => {
    const at = depth <= 0 ? 'direct' : pick(['direct', 'inlinedRef', 'compiledRef', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'cutDeclaration']);
    switch (at) {
      case 'cutDeclaration':
        // The depth limit stops its replay, so its coerced schema accepts more than the server: what reads it must not be stricter.
        return { $ref: 'test/FuzzDeep' };
      case 'inlinedRef':
        return { $ref: 'test/FuzzC' };
      case 'compiledRef':
        return { $ref: 'test/FuzzCW' };
      case 'allOf':
        return { allOf: [reach(depth - 1), pick<Json>([{}, { type: 'array' }, { maxItems: 3 }])] };
      case 'anyOf':
        return { anyOf: pick<Json[]>([[reach(depth - 1), { type: 'null' }], [{ type: 'string' }, reach(depth - 1)]]) };
      case 'oneOf':
        return { oneOf: [reach(depth - 1), { type: 'string' }] };
      case 'not':
        return { not: reach(depth - 1) };
      case 'if':
        return { if: reach(depth - 1), then: pick<Json>([{ minItems: 1 }, { type: 'array' }]), else: pick<Json>([{}, { type: 'null' }]) };
      case 'then':
        return { if: pick<Json>([{ type: 'array' }, { minItems: 1 }]), then: reach(depth - 1) };
      case 'else':
        return { if: { type: 'null' }, else: reach(depth - 1) };
      default:
        return base();
    }
  };
  const item = reach(Math.floor(rnd() * 3));
  switch (pick(['items', 'rest', 'keys', 'pattern'])) {
    case 'items':
      return { type: 'array', items: item };
    case 'rest':
      return { type: 'array', items: [pick<Json>([{ type: 'null' }, {}])], additionalItems: item };
    case 'keys':
      return { type: 'object', ...pick<Json>([{}, { properties: { a: pick<Json>([{ type: 'string' }, { type: 'array' }]) } }]), additionalProperties: item };
    default:
      return { type: 'object', patternProperties: { '^[bn]$': item } };
  }
}

function loopValue(rnd: Random): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const length = 1 + Math.floor(rnd() * 4);
  const items = Array.from({ length }, () => structuredClone(pick(CONTAINS_ITEMS)));
  if (rnd() < 0.5) return items;
  const keys = ['a', 'b', 'n', 'm'].sort(() => rnd() - 0.5);
  return Object.fromEntries(items.map((item, i) => [keys[i % keys.length], item]));
}

const FINITE: Record<string, string> = { Infinity: '7', '-Infinity': '-7', '1e400': '7e0' };

/** `input` with each literal infinity given a finite number of the same kind of text. */
const finite = (input: unknown): unknown => {
  if (typeof input === 'string') return FINITE[input] ?? input;
  if (Array.isArray(input)) return input.map(finite);
  if (typeof input === 'object' && input !== null) return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, finite(v)]));
  return input;
};

// A local loop can try other seeds: FUZZ_SEED=1 FUZZ_SCHEMAS=400.
const SEED = Number(process.env.FUZZ_SEED ?? 20261105);
const SCHEMAS = Number(process.env.FUZZ_SCHEMAS ?? 160);
const INPUTS = 70;

describe('emitZod: the replay of Ajv coercions against the server, on seeded random schemas', function () {
  this.timeout(180000);

  after(clearLoaded);

  // A disagreement that the same input with finite numbers shows as well does not come from an infinity: other coercion
  // orders (ZOD004) and unions of unions are compared by the parity suite. The replay answers for the infinities only.
  it('agrees with the server on every input where only a coerced infinity decides', async () => {
    const rnd = mulberry32(SEED);
    const named: Record<string, unknown> = { FuzzA: { type: 'number' }, FuzzB: { type: 'number', anyOf: [{ $ref: 'test/FuzzA' }] } };
    const ids: string[] = [];
    for (let i = 0; i < SCHEMAS; i++) {
      const s = JSON.parse(JSON.stringify(rnd() < 0.2 ? recursive(rnd) : schema(rnd, 3)).replaceAll(SELF, `test/FuzzRoot${i}`)) as Json;
      named[`FuzzRoot${i}`] = s;
      named[`FuzzNested${i}`] = { type: 'object', properties: { v: s } };
      ids.push(`test/FuzzRoot${i}`, `test/FuzzNested${i}`);
    }
    const manifest = parityManifest(await appBasicManifest(), named);
    const subject = await subjectOf(manifest);
    const found: { stricter: string[]; looser: string[] } = { stricter: [], looser: [] };
    let infinite = 0;
    for (const id of ids) {
      if (!zodSchemaOf(subject, id, 'coerced') || serverRefusal(subject, id, { coerce: true }) !== undefined) continue;
      const inputs = Array.from({ length: INPUTS }, () => (id.includes('Nested') ? { v: value(rnd, 2) } : value(rnd, 2)));
      const result = await parity(manifest, id, { coerce: true, variant: 'coerced' }, inputs);
      expect(result.errors, `${id} errors`).to.deep.equal([]);
      for (const direction of ['stricter', 'looser'] as const) {
        // A looser verdict where ZOD004 says Ajv coerces before a later keyword reads is the diagnosed gap.
        if (direction === 'looser' && diagnosticsFor(subject, id).length > 0) continue;
        const disagreements = direction === 'stricter' ? result.zodStricter : result.zodLooser;
        const changed = disagreements.filter((d) => JSON.stringify(finite(d.input)) !== JSON.stringify(d.input));
        infinite += changed.length;
        if (changed.length === 0) continue;
        const neutral = await parity(manifest, id, { coerce: true, variant: 'coerced' }, changed.map((d) => finite(d.input)));
        const same = new Set([...neutral.zodStricter, ...neutral.zodLooser].map((d) => JSON.stringify(d.input)));
        for (const d of changed.filter((c) => !same.has(JSON.stringify(finite(c.input)))).slice(0, 3)) found[direction].push(`${id} ${JSON.stringify(manifest.schemas[id])} on ${show(d.input)}`);
      }
    }
    expect(infinite, 'disagreements that hold a literal infinity, compared').to.be.at.least(0);
    expect(found).to.deep.equal({ stricter: [], looser: [] });
  });

  // No infinity is needed here: every disagreement counts. A looser one is excused by a diagnostic on the schema.
  it('agrees with the server on a contains behind a reference or a combinator in a loop over items or keys', async () => {
    const rnd = mulberry32(SEED);
    const C = { type: 'array', contains: { type: 'number' } };
    const deep = Array.from({ length: 60 }).reduce<Json>((inner) => ({ not: inner }), { type: 'integer' });
    const named: Record<string, unknown> = { FuzzC: C, FuzzCW: { allOf: [{ $ref: 'test/FuzzC' }] }, FuzzDeep: { anyOf: [deep, { type: 'null' }] } };
    const ids: string[] = [];
    for (let i = 0; i < SCHEMAS; i++) {
      named[`FuzzLoop${i}`] = loopContains(rnd);
      ids.push(`test/FuzzLoop${i}`);
    }
    const manifest = parityManifest(await appBasicManifest(), named);
    const subject = await subjectOf(manifest);
    const found: { stricter: string[]; looser: string[]; errors: string[] } = { stricter: [], looser: [], errors: [] };
    for (const id of ids) {
      if (!zodSchemaOf(subject, id, 'coerced') || serverRefusal(subject, id, { coerce: true }) !== undefined) continue;
      const result = await parity(manifest, id, { coerce: true, variant: 'coerced' }, Array.from({ length: INPUTS * 3 }, () => loopValue(rnd)));
      found.errors.push(...result.errors.slice(0, 2).map((e) => `${id} ${e}`));
      found.stricter.push(...result.zodStricter.slice(0, 2).map((d) => `${id} ${JSON.stringify(manifest.schemas[id])} on ${show(d.input)}`));
      if (diagnosticsFor(subject, id).length === 0) found.looser.push(...result.zodLooser.slice(0, 2).map((d) => `${id} ${JSON.stringify(manifest.schemas[id])} on ${show(d.input)}`));
    }
    expect(found).to.deep.equal({ stricter: [], looser: [], errors: [] });
  });
});
