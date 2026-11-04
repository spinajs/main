import type { FormatCodecs } from './codecs.js';
import { createClient, type ClientDefinition, type ClientOptions } from './http.js';
import { decodePlan, define, encodePlan, own, type ConversionPlan, type ConversionPlans, type PlanContext } from './plan.js';

export interface ModelEntry<T> {
  decode(value: Record<string, unknown>): T;
  encode?(model: T): Record<string, unknown>;
}

/** `args` holds one plan per positional argument; `null` sends the argument as it is. */
export interface RoutePlan {
  reply?: ConversionPlan | null;
  args: (ConversionPlan | null)[];
}

export type RoutePlans = Record<string, Record<string, RoutePlan>>;

export interface ModelClientOptions extends ClientOptions {
  formats?: FormatCodecs;
  models?: Record<string, ModelEntry<unknown>>;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Copies the decoded keys onto `new cls()`; `Object.assign` would run the `__proto__` setter for a JSON `"__proto__"` key. */
export function fromClass<T extends object>(cls: new () => T): ModelEntry<T> {
  return {
    decode(value) {
      const instance = new cls();
      for (const key of Object.keys(value)) if (!UNSAFE_KEYS.has(key)) define(instance, key, value[key]);
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
