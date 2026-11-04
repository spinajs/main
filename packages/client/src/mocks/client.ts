import { MockNotImplemented } from './errors.js';
import { mockSchema } from './sample.js';
import { isObject, own, type MockSchema, type MockSchemas } from './schema.js';

/** Per controller key and handler: the schema of the reply, or `null` for a route that answers with no body. */
export type MockRouteTable = Readonly<Record<string, Readonly<Record<string, MockSchema | null>>>>;

export interface MockClientOptions {
  /** `throw` (default): a method missing from the implementation rejects with `MockNotImplemented`. `mock`: it resolves to mock data of its reply. */
  fallback?: 'throw' | 'mock';
  /** Seed of the `fallback: 'mock'` data; default 1. */
  seed?: number;
}

type Method = (...args: unknown[]) => unknown;

/** A client of type `T` without a network: each method is the one in `impl`, or the fallback. */
export function createMockClient<T>(routes: MockRouteTable, schemas: MockSchemas, impl: object = {}, options: MockClientOptions = {}): T {
  const client: Record<string, Record<string, Method>> = {};
  for (const controller of Object.keys(routes)) {
    const given = own(impl, controller);
    const methods: Record<string, Method> = {};
    for (const handler of Object.keys(routes[controller])) {
      const method = isObject(given) ? own(given, handler) : undefined;
      const route = `${controller}.${handler}`;
      const reply = routes[controller][handler];
      if (typeof method === 'function') methods[handler] = async (...args) => (method as Method).apply(given, args);
      else if (options.fallback === 'mock') methods[handler] = () => Promise.resolve().then(() => (reply === null ? undefined : mockSchema(schemas, reply, route, { seed: options.seed })));
      else methods[handler] = () => Promise.reject(new MockNotImplemented(route));
    }
    client[controller] = methods;
  }
  return client as T;
}
