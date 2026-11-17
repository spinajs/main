import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { OtelTracing } from '../src/tracing.js';

/**
 * Shadow a `@Config`/`@Logger` prototype getter with an own value property: the decorators define getter-only
 * accessors, so a plain assignment throws.
 */
export function setField(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, configurable: true });
}

export const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface TracingFixture {
  tracing: OtelTracing;
  exporter: InMemorySpanExporter;
  /** The fields of every `log.warn` call, in order. */
  warnings: Record<string, unknown>[];
}

/**
 * An OtelTracing with its DI-injected fields set by hand (no container), started on an in-memory exporter.
 * `config` holds the configuration paths that are set, by full path; any other path answers its fallback.
 */
export function makeTracing(enabled = true, config: Record<string, unknown> = {}): TracingFixture {
  const tracing = new OtelTracing();
  const warnings: Record<string, unknown>[] = [];
  setField(tracing, 'enabled', enabled);
  setField(tracing, 'endpoint', 'http://localhost:4318/v1/traces');
  setField(tracing, 'log', { ...silentLog, warn: (fields: Record<string, unknown>) => void warnings.push(fields) });
  setField(tracing, 'cfg', { get: (path: string, fallback?: unknown) => (path in config ? config[path] : fallback) });
  const exporter = new InMemorySpanExporter();
  tracing.start(new SimpleSpanProcessor(exporter));
  return { tracing, exporter, warnings };
}
