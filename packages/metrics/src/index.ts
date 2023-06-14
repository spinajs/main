import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { HttpServer } from '@spinajs/http';
import * as client from 'prom-client';
import { default as promHttpBundle } from 'express-prom-bundle';
import { Configuration } from '@spinajs/configuration';

export const gauge = client.Gauge;
export const histogram = client.Histogram;
export const summary = client.Summary;
export const counter = client.Counter;
@Injectable(Bootstrapper)
export class MetricsBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    client.collectDefaultMetrics({
      labels: { NODE_APP_INSTANCE: process.env.NODE_APP_INSTANCE },
    });

    DI.on('di.resolved.HttpServer', (_: IContainer, server: HttpServer) => {
      const cfg = _.get(Configuration);
      const promCfg = cfg.get<any>('metrics.http');

      server.use(
        promHttpBundle({
          ...promCfg,

          // disable default autoregister
          // we do this by controller with proper auth handling
          autoregister: false,
        }),
      );
    });
  }
}

/**
 * Simple wrapper class for handling prom metrics
 */
export class Metrics {
  protected _histograms: Map<string, client.Histogram>;
  protected _gauges: Map<string, client.Gauge>;
  protected _counters: Map<string, client.Counter>;
  protected _summaries: Map<string, client.Summary>;

  constructor() {
    this._histograms = new Map<string, client.Histogram>();
    this._gauges = new Map<string, client.Gauge>();
    this._counters = new Map<string, client.Counter>();
    this._summaries = new Map<string, client.Summary>();
  }

  public histogram<T extends string>(name: string, configuration: client.HistogramConfiguration<T>) {
    if (!this._histograms.has(name)) {
      this._histograms.set(name, new client.Histogram(configuration));
    }

    return this._histograms.get(name);
  }

  public gauge<T extends string>(name: string, configuration: client.GaugeConfiguration<T>) {
    if (!this._gauges.has(name)) {
      this._gauges.set(name, new client.Gauge(configuration));
    }

    return this._gauges.get(name);
  }

  public counter<T extends string>(name: string, configuration: client.CounterConfiguration<T>) {
    if (!this._counters.has(name)) {
      this._counters.set(name, new client.Gauge(configuration));
    }

    return this._counters.get(name);
  }

  public summary<T extends string>(name: string, configuration: client.SummaryConfiguration<T>) {
    if (!this._summaries.has(name)) {
      this._summaries.set(name, new client.Summary(configuration));
    }

    return this._summaries.get(name);
  }
}
