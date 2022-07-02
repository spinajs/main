import { PureDataTransformer } from './transformers/PureTransformer';
import { ResponseFunction } from './responses';

import { AsyncModule, IContainer, Autoinject, Injectable, Container } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { Server } from 'http';
import { RequestHandler } from 'express';
import { IHttpStaticFileConfiguration, DataTransformer, ServerMiddleware } from './interfaces';
import * as fs from 'fs';
import { UnexpectedServerError, AuthenticationFailed, Forbidden, InvalidArgument, BadRequest, JsonValidationFailed, ExpectedResponseUnacceptable, ResourceNotFound, IOFail, MethodNotImplemented, ResourceDuplicated } from '@spinajs/exceptions';
import { Unauthorized, NotFound, ServerError, BadRequest as BadRequestResponse, Forbidden as ForbiddenResponse, Conflict } from './response-methods';
import Express = require('express');
import { ValidationFailed } from '@spinajs/validation';

@Injectable()
export class HttpServer extends AsyncModule {
  @Autoinject(Configuration)
  protected Configuration: Configuration;

  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(ServerMiddleware)
  protected Middlewares: ServerMiddleware[];

  /**
   * Express app instance
   */
  protected Express: Express.Express;

  /**
   * Http socket server
   */
  protected Server: Server;

  /**
   * Logger for this module
   */
  @Logger('http')
  protected Log: Log;

  constructor() {
    super();
  }

  public async resolveAsync(): Promise<void> {
    this.Express = Express();

    /**
     * Register default middlewares from cfg
     */
    this.Configuration.get<any[]>('http.middlewares', []).forEach((m) => {
      this.use(m);
    });

    // create storage prop in req
    this.use((req: any) => (req.storage = {}));

    this.Middlewares = this.Middlewares.sort((a, b) => {
      return a.Order - b.Order;
    });

    // register other server middlewares
    this.Middlewares.forEach((m) => {
      const f = m.before();
      if (f) this.use(f);
    });

    /**
     * Server static files
     */
    this.Configuration.get<IHttpStaticFileConfiguration[]>('http.Static', []).forEach((s) => {
      if (!fs.existsSync(s.Path)) {
        this.Log.error(`static file path ${s.Path} not exists`);
        return;
      }

      this.Log.info(`Serving static content from: ${s.Path} at prefix: ${s.Route}`);
      this.Express.use(s.Route, Express.static(s.Path));

      this.Container.register(PureDataTransformer).as(DataTransformer);
    });
  }

  /**
   * Starts http server & express
   */
  public start() {
    // start http server & express
    const port = this.Configuration.get('http.port', 1337);
    return new Promise<void>((res, rej) => {
      this.handleResponse();
      this.handleErrors();

      // add all middlewares to execute after
      this.Middlewares.reverse().forEach((m) => {
        const f = m.after();
        if (f) this.use(f);
      });

      this.Server = this.Express.listen(port, () => {
        this.Log.info(`Http server started at port ${port}`);
        res();
      }).on('error', (err: any) => {
        if (err.errno === 'EADDRINUSE') {
          this.Log.error(`----- Port ${port} is busy -----`);
        }

        rej(err);
      });
    });
  }

  public stop() {
    if (this.Server) {
      this.Server.close();
      this.Server = null;
    }
  }

  /**
   * Registers global middleware to express app
   *
   * @param middleware - middleware function
   */
  public use(middleware: RequestHandler): void {
    this.Express.use(middleware);
  }

  /**
   * Executes response
   */
  protected handleResponse() {
    const wrapper = (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
      if (!res.locals.response) {
        next(new ResourceNotFound(`Resource not found ${req.method}:${req.originalUrl}`));
        return;
      }

      res.locals.response.execute(req, res).then((callback: ResponseFunction) => {
        if (callback) {
          callback(req, res);
        }
      });
    };

    Object.defineProperty(wrapper, 'name', {
      value: 'handleResponse',
      writable: true,
    });

    this.Express.use(wrapper);
  }

  /**
   * Handles thrown exceptions in actions.
   */
  protected handleErrors() {
    const wrapper = (err: any, req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
      if (!err) {
        return next();
      }

      this.Log.error(`Route error: ${err}, stack: ${err.stack}`, err.parameter);

      const error = {
        ...err,
        message: err.message,
        stack: {},
      };

      if (process.env.NODE_ENV === 'development') {
        error.stack = err.stack ? err.stack : err.parameter && err.parameter.stack;
      }

      let response = null;

      switch (err.constructor) {
        case AuthenticationFailed:
          response = new Unauthorized({ error });
          break;
        case Forbidden:
          response = new ForbiddenResponse({ error });
          break;
        case ResourceDuplicated:
          response = new Conflict({ error });
          break;
        case InvalidArgument:
        case BadRequest:
        case ValidationFailed:
        case JsonValidationFailed:
        case ExpectedResponseUnacceptable:
          response = new BadRequestResponse({ error });
          break;
        case ResourceNotFound:
          response = new NotFound({ error });
          break;
        case UnexpectedServerError:
        case IOFail:
        case MethodNotImplemented:
        default:
          response = new ServerError({ error });
          break;
      }

      response.execute(req, res).then((callback?: ResponseFunction | void) => {
        if (callback) {
          callback(req, res);
        }
      });
    };

    Object.defineProperty(wrapper, 'name', {
      value: 'handleError',
      writable: true,
    });

    this.Express.use(wrapper);
  }
}
