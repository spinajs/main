import { Response, NextFunction } from 'express';
import { ServerMiddleware, Request as sRequest } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';


/**
 * Create expressjs request storage prop. 
 * Other middlewares / modules could use it for per request storage app wise
 */
@Injectable(ServerMiddleware)
export class RequestStorage extends ServerMiddleware {
  constructor() {
    super();
    this.Order = -2;
  }

  public after(): (_req: sRequest, _res: express.Response, next: express.NextFunction) => void {
    return null;
  }

  public before(): (req: sRequest, res: Response<any, Record<string, any>>, next: NextFunction) => void {
    return (req: any, _res: express.Response, next: express.NextFunction) => {
      req.storage = {};
      next();
    };
  }
}
