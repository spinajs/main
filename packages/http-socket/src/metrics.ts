import { DI } from '@spinajs/di';
import { MetricDef, MetricMap, Metrics } from '@spinajs/telemetry-common';
import type { Counter, Gauge, Histogram } from '@spinajs/telemetry-common';

export const SOCKET_METRIC_PREFIX = 'socket';
export const SOCKET_METRIC_KEY_COMMANDS = 'commands_total';
export const SOCKET_METRIC_KEY_DURATION = 'command_duration_seconds';
export const SOCKET_METRIC_KEY_CONNECTIONS = 'connections';
export const SOCKET_METRIC_KEY_STREAMS = 'streams_total';
export const SOCKET_DURATION_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** Label of a command no handler is registered for: names come from the client and must not reach label values. */
export const SOCKET_UNKNOWN_COMMAND = '<unknown>';

const SOCKET_METRIC_DEFS: MetricDef[] = [
  { name: SOCKET_METRIC_KEY_COMMANDS, help: 'Socket commands answered, by command and reply code', type: 'counter', labelNames: ['command', 'code'] },
  { name: SOCKET_METRIC_KEY_DURATION, help: 'Seconds from receiving a socket command to its reply', type: 'histogram', labelNames: ['command'], buckets: SOCKET_DURATION_BUCKETS_SECONDS },
  { name: SOCKET_METRIC_KEY_CONNECTIONS, help: 'Open socket connections', type: 'gauge' },
  { name: SOCKET_METRIC_KEY_STREAMS, help: 'Socket stream replies ended, by command and outcome ( ok or the error code )', type: 'counter', labelNames: ['command', 'code'] },
];

// defineMetrics rebuilds ( and so resets ) its metrics on every call: build once per Metrics service.
const DEFINED = new WeakMap<Metrics, MetricMap>();

/** Null when telemetry cannot be resolved: publishing a metric must never fail a command. */
export function socketMetrics(): MetricMap | null {
  try {
    const service = DI.get(Metrics) ?? DI.resolve(Metrics);
    let map = DEFINED.get(service);

    if (!map) {
      map = service.defineMetrics(SOCKET_METRIC_PREFIX, SOCKET_METRIC_DEFS);
      DEFINED.set(service, map);
    }

    return map;
  } catch {
    return null;
  }
}

export function observeCommand(command: string, code: string, seconds: number): void {
  const metrics = socketMetrics();
  if (!metrics) {
    return;
  }

  (metrics[SOCKET_METRIC_KEY_COMMANDS] as Counter<string>).inc({ command, code });
  (metrics[SOCKET_METRIC_KEY_DURATION] as Histogram<string>).observe({ command }, seconds);
}

export function observeStream(command: string, code: string): void {
  const metrics = socketMetrics();
  if (!metrics) {
    return;
  }

  (metrics[SOCKET_METRIC_KEY_STREAMS] as Counter<string>).inc({ command, code });
}

/** Counts one open connection; the returned release decrements the same gauge, even after a DI reset. */
export function trackConnection(): () => void {
  const gauge = socketMetrics()?.[SOCKET_METRIC_KEY_CONNECTIONS] as Gauge<string> | undefined;
  gauge?.inc();
  return () => gauge?.dec();
}
