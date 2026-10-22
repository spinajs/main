import type { Configuration } from '@spinajs/configuration';

/** Writes `value` without the schema check of Configuration.set, to test what reads a value that got past the schema. */
export function setPastSchema(configuration: Configuration, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = (configuration as unknown as { Config: Record<string, Record<string, unknown>> }).Config as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
}
