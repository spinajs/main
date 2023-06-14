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

    DI.on('di.resolved.HttpServer',(_ : IContainer, server : HttpServer)=>{ 
      
      const cfg = _.get(Configuration);
      const promCfg = cfg.get<any>('metrics.http');

      server.use(promHttpBundle({
        ...promCfg,

        // disable default autoregister
        // we do this by controller with proper auth handling
        autoregister: false
      }));
    });
  }
}
