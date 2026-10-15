import { DI } from '@spinajs/di';
import { Counter, Gauge, Histogram, MetricDef, MetricMap, Metrics } from '@spinajs/telemetry-common';

export const SCHEDULER_METRIC_PREFIX = 'scheduler';

const DURATION_BUCKETS = [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600, 14_400];

export const SCHEDULER_METRIC_DEFS: MetricDef[] = [
  {
    name: 'runs_total',
    help: 'Scheduler runs by final status',
    type: 'counter',
    labelNames: ['name', 'status', 'trigger'],
  },
  {
    name: 'run_duration_seconds',
    help: 'Duration of finished scheduler runs',
    type: 'histogram',
    labelNames: ['name'],
    buckets: DURATION_BUCKETS,
  },
  {
    name: 'step_duration_seconds',
    help: 'Duration of run steps',
    type: 'histogram',
    labelNames: ['name', 'step'],
    buckets: DURATION_BUCKETS,
  },
  {
    name: 'lag_seconds',
    help: 'Delay between the scheduled time and the start of the latest run',
    type: 'gauge',
    labelNames: ['name'],
  },
  { name: 'retries_total', help: 'Automatic retries scheduled', type: 'counter', labelNames: ['name'] },
  {
    name: 'consecutive_failures',
    help: 'Consecutive failed runs per schedule',
    type: 'gauge',
    labelNames: ['name'],
  },
];

// defineMetrics rebuilds (and so resets) the set on every call: build it once per Metrics instance.
const DEFINED = new WeakMap<Metrics, MetricMap>();

/** Null when the metrics service cannot be resolved: publishing a metric must never fail a run. */
export function schedulerMetrics(): MetricMap | null {
  try {
    const service = DI.get(Metrics) ?? DI.resolve(Metrics);
    let map = DEFINED.get(service);
    if (!map) {
      map = service.defineMetrics(SCHEDULER_METRIC_PREFIX, SCHEDULER_METRIC_DEFS);
      DEFINED.set(service, map);
    }
    return map;
  } catch {
    return null;
  }
}

export function schedulerCounter(m: MetricMap, key: string): Counter<string> {
  // eslint-disable-next-line security/detect-object-injection
  return m[key] as Counter<string>;
}

export function schedulerGauge(m: MetricMap, key: string): Gauge<string> {
  // eslint-disable-next-line security/detect-object-injection
  return m[key] as Gauge<string>;
}

export function schedulerHistogram(m: MetricMap, key: string): Histogram<string> {
  // eslint-disable-next-line security/detect-object-injection
  return m[key] as Histogram<string>;
}
