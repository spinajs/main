import { BasePath, BaseController, Get, Response } from '@spinajs/http';
import * as client from 'prom-client';
import * as express from 'express';

class PrometheusResponse extends Response {
  constructor() {
    super(null);
  }

  public async execute(_req: express.Request, res: express.Response) {
    res.contentType(client.register.contentType);
    res.end(client.register.metrics());
  }
}

@BasePath('metrics')
export class Metrics extends BaseController {
  @Get()
  public async getMetrics() {
    return new PrometheusResponse();
  }
}
