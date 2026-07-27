export * from './metrics.js';

// The prom-client metric classes are part of this package's public surface: `defineMetrics`
// hands them back, and a consumer has to narrow `AnyMetric` before it can `.set()` or
// `.observe()`. Re-exporting them here means a consumer needs no direct prom-client dependency
// of its own — the point of a `-common` package.
export type { Counter, Gauge, Histogram, Summary, Registry } from 'prom-client';
