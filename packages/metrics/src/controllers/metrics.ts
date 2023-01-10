import { Injectable, Bootstrapper } from '@spinajs/di';
import * as client from 'prom-client';

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
  }
}
