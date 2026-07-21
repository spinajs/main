import { Response, NextFunction } from 'express';
import { ServerMiddleware, Request as sRequest } from '../interfaces.js';
import * as express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Injectable } from '@spinajs/di';

@Injectable(ServerMiddleware)
export class RequestId extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public after(): null {
    // The x-request-id header is set in before() instead. ServerMiddleware
    // after() handlers do NOT run for matched controller routes (the response
    // is flushed inside the controllers router without calling next()), so
    // setting the header here would silently drop it on every real response.
    return null;
  }

  public before(): (req: sRequest, res: Response<any, Record<string, any>>, next: NextFunction) => void {
    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      req.storage.requestId = uuidv4();
      // Set the header up-front, before any handler can flush the response.
      res.header('x-request-id', req.storage.requestId);
      next();
    };
  }
}
