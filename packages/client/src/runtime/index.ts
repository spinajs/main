export * from './http.js';
export * from './errors.js';
export { DEFAULT_FORWARDED_HEADERS, forwardedHeaders, serverClientOptions } from './forward.js';
export type { IncomingHeaders, ServerClientOptions, ServerClientResult } from './forward.js';
export { serializeQuery } from './query.js';
export type { ArgLocation, ArgShape, ArgWire } from './wire.js';
export * from './codecs.js';
export type { ConversionPlan, ConversionPlans, ObjectPlanOf } from './plan.js';
export { createModelClient, fromClass, type ModelClientOptions, type ModelEntry, type RoutePlan, type RoutePlans } from './models.js';
export type { ArgOf, Defined, FormatSlots, ModelMap, ModelOf, NoEntries, ReplyOf } from './models.js';
export * from './form-errors.js';

/** What a field-filtered route or command returns (`fields: 'filter' | 'filter-rows'`): any property may be redacted away. */
export type Redacted<T> = T extends readonly (infer E)[] ? Redacted<E>[] : T extends object ? { [K in keyof T]?: T[K] | undefined } : T;
