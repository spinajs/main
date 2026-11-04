import type { FormatCodecs, Formats } from './codecs.js';
import type { ModelEntry } from './models.js';

/**
 * How a value converts between wire JSON and the app's types. An object property planned as `null` is declared but
 * passes through unchanged: a closed object needs every declared name to project onto.
 */
export type ConversionPlan =
  | { kind: 'format'; format: keyof Formats }
  | { kind: 'ref'; name: string }
  | { kind: 'array'; items: ConversionPlan }
  | { kind: 'record'; values: ConversionPlan }
  | { kind: 'object'; closed: boolean; props: Record<string, ConversionPlan | null> }
  /** `mapping` maps a discriminator value to a name in `ConversionPlans`. */
  | { kind: 'union'; discriminator?: { property: string; mapping: Record<string, string> }; members: ConversionPlan[] };

export type ConversionPlans = Record<string, ConversionPlan>;

export interface PlanContext {
  plans: ConversionPlans;
  formats: FormatCodecs;
  models: Record<string, ModelEntry<unknown>>;
}

type Bag = Record<string, unknown>;
type PlanOf<K extends ConversionPlan['kind']> = Extract<ConversionPlan, { kind: K }>;
type Walker = { [K in ConversionPlan['kind']]: (plan: PlanOf<K>, value: unknown, ctx: PlanContext) => unknown };

const isBag = (value: unknown): value is Bag => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Wire text such as a `"constructor"` tag must never select a plan, codec or model from `Object.prototype`. */
export function own<T>(record: { readonly [key: string]: T } | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Defines instead of assigning, so a `"__proto__"` key stays an own data property and no setter runs. */
export function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function mapEntries(source: Bag, keys: string[], convert: (key: string, item: unknown) => unknown): Bag {
  const out: Bag = {};
  for (const key of keys) {
    const item = source[key];
    if (item !== undefined) define(out, key, convert(key, item));
  }
  return out;
}

const isKind =
  <K extends ConversionPlan['kind']>(kind: K) =>
  (plan: ConversionPlan | null | undefined): plan is PlanOf<K> =>
    plan?.kind === kind;

const same = (plans: (ConversionPlan | null | undefined)[]): boolean => plans.every((plan) => JSON.stringify(plan ?? null) === JSON.stringify(plans[0] ?? null));

// Members that differ are wrapped in a nested union, agreed only when data reaches it: plan cycles through `ref` stay finite.
function agreeOn(plans: (ConversionPlan | null | undefined)[]): ConversionPlan | null {
  if (same(plans)) return plans[0] ?? null;
  const members = plans.filter((plan): plan is ConversionPlan => !!plan);
  return members.length === plans.length ? { kind: 'union', members } : null;
}

function sharedProps(objects: PlanOf<'object'>[]): Record<string, ConversionPlan | null> {
  const props: Record<string, ConversionPlan | null> = {};
  for (const key of Object.keys(objects[0].props)) {
    if (!objects.every((object) => own(object.props, key) !== undefined)) continue;
    const plan = agreeOn(objects.map((object) => object.props[key]));
    if (plan) define(props, key, plan);
  }
  return props;
}

/** Converts only where every member agrees; the result is open, so encoding never drops one member's own fields. */
function agree(members: ConversionPlan[], plans: ConversionPlans): ConversionPlan | null {
  if (members.length === 0) return null;
  if (same(members)) return members[0];
  const resolved = members.map((member) => (member.kind === 'ref' ? own(plans, member.name) : member));
  if (resolved.every(isKind('object'))) return { kind: 'object', closed: false, props: sharedProps(resolved) };
  if (resolved.every(isKind('array'))) {
    const items = agreeOn(resolved.map((plan) => plan.items));
    return items && { kind: 'array', items };
  }
  if (resolved.every(isKind('record'))) {
    const values = agreeOn(resolved.map((plan) => plan.values));
    return values && { kind: 'record', values };
  }
  return null;
}

const agreed = new WeakMap<ConversionPlans, WeakMap<PlanOf<'union'>, ConversionPlan | null>>();

function agreedPlan(plan: PlanOf<'union'>, plans: ConversionPlans): ConversionPlan | null {
  let cache = agreed.get(plans);
  if (!cache) agreed.set(plans, (cache = new WeakMap()));
  let merged = cache.get(plan);
  if (merged === undefined) cache.set(plan, (merged = agree(plan.members, plans)));
  return merged;
}

function unionMember(plan: PlanOf<'union'>, value: unknown, plans: ConversionPlans): ConversionPlan | null {
  const tag = plan.discriminator && isBag(value) ? value[plan.discriminator.property] : undefined;
  const name = typeof tag === 'string' ? own(plan.discriminator?.mapping, tag) : undefined;
  return name !== undefined ? { kind: 'ref', name } : agreedPlan(plan, plans);
}

function walk(walker: Walker, plan: ConversionPlan | null | undefined, value: unknown, ctx: PlanContext): unknown {
  if (!plan || value === null || value === undefined) return value;
  return (walker[plan.kind] as (plan: ConversionPlan, value: unknown, ctx: PlanContext) => unknown)(plan, value, ctx);
}

const DECODE: Walker = {
  format: (plan, value, ctx) => {
    const codec = own(ctx.formats, plan.format);
    return codec ? codec.decode(value) : value;
  },
  ref: (plan, value, ctx) => {
    const decoded = decodePlan(own(ctx.plans, plan.name), value, ctx);
    const model = own(ctx.models, plan.name);
    return model && isBag(decoded) ? model.decode(decoded) : decoded;
  },
  array: (plan, value, ctx) => (Array.isArray(value) ? value.map((item: unknown) => decodePlan(plan.items, item, ctx)) : value),
  record: (plan, value, ctx) => (isBag(value) ? mapEntries(value, Object.keys(value), (_key, item) => decodePlan(plan.values, item, ctx)) : value),
  object: (plan, value, ctx) => (isBag(value) ? mapEntries(value, Object.keys(value), (key, item) => decodePlan(own(plan.props, key), item, ctx)) : value),
  union: (plan, value, ctx) => decodePlan(unionMember(plan, value, ctx.plans), value, ctx),
};

function viaToJSON(value: unknown): unknown {
  return isBag(value) && typeof value.toJSON === 'function' ? (value.toJSON as () => unknown)() : value;
}

const ENCODE: Walker = {
  format: (plan, value, ctx) => {
    const codec = own(ctx.formats, plan.format);
    return codec ? codec.encode(value) : value;
  },
  ref: (plan, value, ctx) => {
    const model = own(ctx.models, plan.name);
    const source = model?.encode && isBag(value) ? model.encode(value) : value;
    return encodePlan(own(ctx.plans, plan.name), source, ctx);
  },
  array: (plan, value, ctx) => (Array.isArray(value) ? value.map((item: unknown) => encodePlan(plan.items, item, ctx)) : value),
  record: (plan, value, ctx) => {
    const source = viaToJSON(value);
    return isBag(source) ? mapEntries(source, Object.keys(source), (_key, item) => encodePlan(plan.values, item, ctx)) : source;
  },
  // Reading declared names (not own keys) keeps a declared getter and drops whatever else the instance carries.
  object: (plan, value, ctx) => {
    const source = viaToJSON(value);
    if (!isBag(source)) return source;
    return mapEntries(source, Object.keys(plan.closed ? plan.props : source), (key, item) => encodePlan(own(plan.props, key), item, ctx));
  },
  union: (plan, value, ctx) => encodePlan(unionMember(plan, value, ctx.plans), value, ctx),
};

/** Wire JSON to app values; keys without a plan pass through, and the wire value is not mutated. */
export function decodePlan(plan: ConversionPlan | null | undefined, value: unknown, ctx: PlanContext): unknown {
  return walk(DECODE, plan, value, ctx);
}

/** App values to the JSON the server validates: model `encode` (else `toJSON`), codecs, then closed-object projection. */
export function encodePlan(plan: ConversionPlan | null | undefined, value: unknown, ctx: PlanContext): unknown {
  return walk(ENCODE, plan, value, ctx);
}
