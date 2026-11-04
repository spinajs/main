import type { FormatCodecs, Formats } from './codecs.js';
import { createClient, type ClientDefinition, type ClientOptions } from './http.js';
import { decodePlan, define, encodePlan, own, type ConversionPlan, type ConversionPlans, type PlanContext } from './plan.js';

export interface ModelEntry<T> {
  /** Gets the decoded value: only its declared properties when the plan is a closed object, every own key when open. */
  decode(value: Record<string, unknown>): T;
  encode?(model: T): Record<string, unknown>;
}

/** `args` holds one plan per positional argument; `null` sends the argument as it is. */
export interface RoutePlan {
  reply?: ConversionPlan | null;
  args: (ConversionPlan | null)[];
}

export type RoutePlans = Record<string, Record<string, RoutePlan>>;

/** The model registered for `K` in `M`, else `Fallback`; a `null` that `Fallback` allows is kept. */
export type ModelOf<M, K extends string, Fallback> = K extends keyof M ? (M[K] extends ModelEntry<infer T> ? T | Extract<Fallback, null> : Fallback) : Fallback;

// The generated client imports the helpers below under `$` aliases, which no DTO name can take, so a DTO named like a
// global type (`Record`, `Partial`, `NonNullable`) cannot shadow what the model types are built from.
/** Every format slot: the model types take a complete map, such as `FormatTypes<…>`. */
export type FormatSlots = Required<Formats>;
export type NoEntries = Record<never, never>;
export type ModelMap<Name extends string> = Partial<Record<Name, ModelEntry<unknown>>>;
export type Defined<T> = NonNullable<T>;
export type ReplyOf<T> = T extends (...args: never[]) => Promise<infer R> ? R : never;
export type ArgOf<T, I extends number> = T extends (...args: infer A) => unknown ? A[I] : never;

export interface ModelClientOptions extends ClientOptions {
  formats?: FormatCodecs;
  models?: Record<string, ModelEntry<unknown>>;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The class's own member under `key`, found below `Object.prototype`, whose members a reply value may shadow. */
function classMember(instance: object, key: string): PropertyDescriptor | undefined {
  for (let proto: unknown = Object.getPrototypeOf(instance); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const member = Object.getOwnPropertyDescriptor(proto, key);
    if (member) return member;
  }
  return undefined;
}

function copyKey(instance: object, key: string, value: unknown): void {
  const member = Object.prototype.hasOwnProperty.call(instance, key) ? undefined : classMember(instance, key);
  if (member?.set) (instance as Record<string, unknown>)[key] = value;
  else if (!member || (!member.get && typeof member.value !== 'function')) define(instance, key, value);
}

/**
 * Copies the decoded keys onto `new cls()`: through the class's setter where it has one, never over a method or a
 * getter without a setter. `Object.assign` would also run the `__proto__` setter for a JSON `"__proto__"` key.
 */
export function fromClass<T extends object>(cls: new () => T): ModelEntry<T> {
  return {
    decode(value) {
      const instance = new cls();
      for (const key of Object.keys(value)) if (!UNSAFE_KEYS.has(key)) copyKey(instance, key, value[key]);
      return instance;
    },
  };
}

type Method = (...args: unknown[]) => Promise<unknown>;

function withPlan(method: Method, route: RoutePlan, ctx: PlanContext): Method {
  return async (...args) => decodePlan(route.reply, await method(...args.map((arg, i) => encodePlan(route.args[i], arg, ctx))), ctx);
}

/** `createClient` that decodes replies and encodes arguments by plan; without `formats` and `models` it is `createClient`. */
export function createModelClient<T>(definition: ClientDefinition, plans: ConversionPlans, routePlans: RoutePlans, options: ModelClientOptions): T {
  if (!options.formats && !options.models) return createClient<T>(definition, options);
  const ctx: PlanContext = { plans, formats: options.formats ?? {}, models: options.models ?? {} };
  const client = createClient<Record<string, Record<string, Method>>>(definition, options);
  for (const [controller, methods] of Object.entries(client)) {
    for (const [name, method] of Object.entries(methods)) {
      const route = own(own(routePlans, controller), name);
      if (route) methods[name] = withPlan(method, route, ctx);
    }
  }
  return client as T;
}
