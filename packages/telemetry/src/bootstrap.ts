import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Perf } from '@spinajs/log';

import { Metrics } from './metrics.js';
import { PromMetricSink } from './PromMetricSink.js';
import { InMemoryPerfSink } from './InMemoryPerfSink.js';

/**
 * Wires the telemetry collection layer at startup:
 *
 *  - registers prom-client's default process metrics against the PRIVATE
 *    registry ( never the global default one ), when configured,
 *  - resolves both perf sinks and refreshes the Perf facade's sink list, so the
 *    perf bridge is live in apps that use telemetry WITHOUT @spinajs/http.
 *
 * `TelemetryMiddleware.resolve()` does the same sink wiring for the http case.
 * Both paths are idempotent ( the sinks are singletons and `refreshSinks` just
 * drops a memo ).
 */
@Injectable(Bootstrapper)
export class TelemetryBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    const cfg = DI.get(Configuration);
    const metrics = DI.get(Metrics) ?? DI.resolve(Metrics);

    if (cfg?.get<boolean>('telemetry.collectDefaultMetrics', true)) {
      metrics.collectDefault();
    }

    DI.resolve(PromMetricSink);
    DI.resolve(InMemoryPerfSink);
    Perf.refreshSinks();
  }
}
