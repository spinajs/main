export * from './http.js';
export * from './errors.js';
export { serializeQuery } from './query.js';
export type { ArgLocation, ArgShape, ArgWire } from './wire.js';

/** What a field-filtered route or command returns (`fields: 'filter' | 'filter-rows'`): any property may be redacted away. */
export type Redacted<T> = T extends readonly (infer E)[] ? Redacted<E>[] : T extends object ? { [K in keyof T]?: T[K] | undefined } : T;
