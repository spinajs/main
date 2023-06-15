import { BasePath, BaseController, Get, Response, Policy } from '@spinajs/http';
import * as client from 'prom-client';
import * as express from 'express';

class PrometheusResponse extends Response {
  constructor() {
    super(null);
  }

  public async execute(_req: express.Request, res: express.Response) {

    const result = await client.register.metrics();

    res.contentType(client.register.contentType);
    res.end(result);
  }
}

/**
 * Default controller for serving
 * metrics data. Can be protected by access policy from configuration file
 */
@BasePath('metrics')
@Policy('metrics.auth.policy')
export class Metrics extends BaseController {
  @Get('/')
  public async getMetrics() {
    return new PrometheusResponse();
  }
}
