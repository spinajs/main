import { AsyncService, IContainer, Autoinject, Injectable, Container, Inject, DI, Constructor } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { fsNative, IFsLocalOptions } from '@spinajs/fs';
import { ResourceNotFound } from '@spinajs/exceptions';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-pug';

import { Server as Http, createServer as HttpCreateServer } from 'http';
import { Server as Https, createServer as HttpsCreateServer } from 'https';
import { existsSync } from 'fs';
import cors from 'cors';
import randomstring from 'randomstring';
import Express, { RequestHandler } from 'express';
import _ from 'lodash';
import fs from 'fs';

import { ServerMiddleware, ResponseFunction, HTTP_STATUS_CODE, HttpAcceptHeaders, IHttpServerConfiguration, Response as HttpResponse } from './interfaces.js';
import { ServerError } from './response-methods/index.js';
import './transformers/index.js';
import './middlewares/ResponseTime.js';
import './middlewares/RequestId.js';
import './middlewares/RealIp.js';
import './middlewares/ReqStorage.js';

@Injectable()
@Inject(Templates)
export class HttpServer extends AsyncService {
  @Autoinject(Configuration)
  protected Configuration: Configuration;

  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(ServerMiddleware)
  protected Middlewares: ServerMiddleware[];

  @Config('http')
  protected HttpConfig: IHttpServerConfiguration;

  @Config('https')
  protected HttpsEnabled: boolean;

  @Config('process.env.APP_ENV', {
    defaultValue: 'development',
  })
  protected AppEnv: string;

  /**
   * Express app instance
   */
  protected Express: Express.Express;

  /**
   * Http socket server
   */
  protected _httpServer: Http;
  protected _httpsServer: Https;

  public get Server(): Http | Https {
    return this.HttpsEnabled ? this._httpsServer : this._httpServer;
  }

  /**
   * Logger for this module
   */
  @Logger('http')
  protected Log: Log;

  constructor() {
    super();
  }

  public async resolve(): Promise<void> {
    this.Express = Express();
    this.Server = this._createServer();
    this.Middlewares = this.Middlewares.sort((a, b) => {
      return a.Order - b.Order;
    });

    const f = DI.resolve<fsNative<IFsLocalOptions>>('__file_provider__', ['__fs_http_response_templates__']);
    if (!f) {
      this.Log.info(`No fs provider for __fs_http_response_templates__ registered, response templates will not be available.`);
    } else {
      this.Log.info(`Response templates path at ${f.Options.basePath}`);
    }

    this.HttpConfig.middlewares.forEach((m) => {
      this.Log.info(`Using server middleware::before() - ${m.constructor.name}`);
      this.use(m);
    });

    /**
     * Register cors options
     */

    const cOptions = this.Configuration.get<any>('http.cors', undefined);
    if (!cOptions) {
      this.Log.warn(`CORS options not set, server may be unavaible from outside ! Please set http.cors configuration option.`);
    } else {
      const corsOptions = {
        origin(origin: any, callback: any) {
          if (!cOptions || cOptions.origins.length === 0 || cOptions.origins.indexOf(origin) !== -1) {
            callback(null, true);
          } else {
            callback(new Error('cors not allowed'));
          }
        },
        exposedHeaders: cOptions.exposedHeaders,
        allowedHeaders: cOptions.allowedHeaders,
        credentials: true,
      };

      this.use(cors(corsOptions));
    }

    // register other server middlewares
    this.Middlewares.forEach((m) => {
      const f = m.before();
      if (f) {
        this.Log.info(`Using server middleware::before() - ${m.constructor.name}`);
        this.use(f);
      }
    });

    this._serverStaticFiles();
  }

  /**
   * Create http or https server
   */
  private _createServer(): any {
    if (this.HttpsEnabled) {
      this.Log.info(`Using https key file ${this.HttpConfig.ssl.key}`);
      this.Log.info(`Using https cert file ${this.HttpConfig.ssl.cert}`);

      const key = fs.readFileSync(this.HttpConfig.ssl.key);
      const cert = fs.readFileSync(this.HttpConfig.ssl.cert);

      this.Log.info(`HTTPS enabled !`);

      return HttpsCreateServer(
        {
          key: key,
          cert: cert,
        },
        this.Express,
      );
    } else {
      this.Log.info(`HTTP enabled !`);
      return HttpCreateServer(this.Express);
    }
  }

  /**
   * Server static files
   */
  private _serverStaticFiles() {
    _.uniq(this.HttpConfig.Static).forEach((s) => {
      if (!existsSync(s.Path)) {
        this.Log.warn(`static file path ${s.Path} not exists`);
        return;
      }

      const sRoute = s.Route ?? '/static';

      this.Log.info(`Serving static content from: ${s.Path} at path: ${sRoute}`);
      this.Express.use(sRoute, Express.static(s.Path));
    });
  }

  /**
   * Starts http server & express
   */
  public start() {
    return new Promise<void>((res, rej) => {
      this.handleResponse();
      this.handleErrors();

      // add all middlewares to execute after
      this.Middlewares.reverse().forEach((m) => {
        const f = m.after();
        if (f) {
          this.Log.info(`Using server middleware::after() - ${m.constructor.name}`);
          this.use(f);
        }
      });

      this.Server.listen(this.HttpConfig.port, () => {
        this.Log.info(`Server started at port ${this.HttpConfig.port}`);
        res();
      }).on('error', (err: any) => {
        if (err.errno === 'EADDRINUSE') {
          this.Log.error(`----- Port ${this.HttpConfig.port} is busy -----`);
        }

        rej(err);
      });
    });
  }

  public stop() {
    if (this.Server) {
      this.Server.close();
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

      res.locals.response
        .execute(req, res)
        .then((callback: ResponseFunction) => {
          if (callback) {
            return callback(req, res);
          }
        })
        .catch((err: Error) => {
          next(err);
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

      this.Log.error(err, `Route error: ${err}, stack: ${err.stack}`);

      const error = {
        /**
         * By default Error object dont copy values like message ( they are not enumerable )
         * It only copies custom props added to Error ( via inheritance )
         */
        ...err,

        // make sure error message is added
        message: err.message,
        stack: {},
      };

      // in dev mode add stack trace for debugging
      if (this.AppEnv === 'development') {
        error.stack = err.stack ? err.stack : err.parameter && err.parameter.stack;
      }

      let response: HttpResponse = null;
      const rMap = DI.get<Map<string, Constructor<HttpResponse>>>('__http_error_map__');
      if (rMap.has(err.constructor.name)) {
        const httpResponse = rMap.get(err.constructor.name);
        response = new httpResponse(error);
      } else {
        this.Log.warn(`Error type ${error.constructor} dont have assigned http response. Map error to response via _http_error_map__ in DI container`);
        response = new ServerError(error);
      }

      response
        .execute(req, res)
        .then((callback?: ResponseFunction | void) => {
          if (callback) {
            callback(req, res);
          }
        })
        .catch((err: Error) => {
          // last resort error handling

          this.Log.fatal(err, `Cannot send error response`);
          res.status(HTTP_STATUS_CODE.INTERNAL_ERROR);

          if (req.accepts('html') && (this.HttpConfig.AcceptHeaders & HttpAcceptHeaders.HTML) === HttpAcceptHeaders.HTML) {
            // final fallback rendering error fails, we render embedded html error page
            const ticketNo = randomstring.generate(7);
            res.send(this.HttpConfig.FatalTemplate.replace('{ticket}', ticketNo));
          } else {
            res.json(error);
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
