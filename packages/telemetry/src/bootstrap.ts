import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import { Configuration, registerConfigurationSchema } from '@spinajs/configuration';
import { Perf, PerfSink } from '@spinajs/log';

import { Metrics } from './metrics.js';
import { TELEMETRY_CONFIGURATION_SCHEMA } from './schema.js';

/**
 * Wires the telemetry collection layer at startup:
 *
 *  - registers prom-client's default process metrics against the PRIVATE
 *    registry ( never the global default one ), when configured,
 *  - builds the perf sinks and refreshes the Perf facade's sink list, so the
 *    perf bridge is live in apps that use telemetry WITHOUT @spinajs/http.
 */
@Injectable(Bootstrapper)
export class TelemetryBootstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    registerConfigurationSchema(TELEMETRY_CONFIGURATION_SCHEMA);
    const cfg = await DI.resolve(Configuration);
    const metrics = DI.get(Metrics) ?? DI.resolve(Metrics);

    if (cfg.get<boolean>('telemetry.collectDefaultMetrics', true)) {
      metrics.collectDefault();
    }

    // Build the sinks through the ARRAY, never with a direct
    // `DI.resolve( PromMetricSink )`. A direct resolve caches the instance under
    // its own type name only; the later `Array.ofType( PerfSink )` — which is
    // what the Perf facade uses — then hits that cache entry on its fast path,
    // returns it WITHOUT adding it to the `PerfSink` list, and the facade stays
    // blind to that sink. Resolving the array first creates them together.
    const sinks = await DI.resolve(Array.ofType(PerfSink));

    // The array cache does not double as a per-type cache, so publish each
    // instance under its own type name too. Without this a later
    // `@Autoinject( InMemoryPerfSink )` ( the telemetry controller does exactly
    // that ) would build a SECOND, permanently empty sink.
    //
    // Replace, not append: the resolve fast path hands out the first entry, so an
    // instance resolved directly BEFORE this bootstrapper ran would otherwise pin
    // `@Autoinject` to that earlier, permanently empty sink. A cache entry, not
    // `asValue`: values survive clearCache(), the sink must go with its Metrics.
    for (const sink of sinks) {
      DI.uncache(sink.constructor.name);
      DI.RootContainer.Cache.add(sink.constructor.name, sink);
    }

    Perf.refreshSinks();
  }
}
