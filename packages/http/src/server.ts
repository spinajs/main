import { AsyncService, IContainer, Autoinject, Injectable, Container, Inject, DI } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { fsNative, IFsLocalOptions } from '@spinajs/fs';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-pug';

import { Server as Http, createServer as HttpCreateServer } from 'http';
import { Server as Https, createServer as HttpsCreateServer } from 'https';
import { existsSync } from 'fs';
import cors from 'cors';
import Express, { ErrorRequestHandler, RequestHandler } from 'express';
import _ from 'lodash';
import fs from 'fs';

import { ServerMiddleware, IHttpServerConfiguration } from './interfaces.js';
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

  /**
   * Track active connections for cleanup
   */
  protected _connections = new Set<any>();

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
    this.Middlewares = this.Middlewares.sort((a, b) => {
      return a.Order - b.Order;
    });
  
    this._createServer();

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
  private _createServer()  {
    if (this.HttpsEnabled) {
      this.Log.info(`Using https key file ${this.HttpConfig.ssl.key}`);
      this.Log.info(`Using https cert file ${this.HttpConfig.ssl.cert}`);

      const key = fs.readFileSync(this.HttpConfig.ssl.key);
      const cert = fs.readFileSync(this.HttpConfig.ssl.cert);

      this.Log.info(`HTTPS enabled !`);

      this._httpsServer = HttpsCreateServer(
        {
          key: key,
          cert: cert,
        },
        this.Express,
      );
      
      // Track connections for cleanup
      this._httpsServer.on('connection', (socket) => {
        this._connections.add(socket);
        socket.on('close', () => {
          this._connections.delete(socket);
        });
      });
    } else {
      this.Log.info(`HTTP enabled !`);
      this._httpServer = HttpCreateServer(this.Express);
      
      // Track connections for cleanup
      this._httpServer.on('connection', (socket) => {
        this._connections.add(socket);
        socket.on('close', () => {
          this._connections.delete(socket);
        });
      });
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
   * Enhanced dispose method with proper connection cleanup and timeout handling
   */
  public async dispose(): Promise<void> {
    if (!this.Server) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      // Set a timeout for graceful shutdown
      const timeout = setTimeout(() => {
        this.Log.warn('Server shutdown timeout, forcing close');
        
        // Force close all tracked connections
        this._forceCloseConnections();
        
        // Force close connections if available (Node.js 18.2+)
        if (typeof this.Server.closeAllConnections === 'function') {
          this.Server.closeAllConnections();
        }
        
        // Still resolve as we've done our best to clean up
        resolve();
      }, 10000);

      this.Server.close((err) => {
        clearTimeout(timeout);
        
        if (err) {
          this.Log.error('Error during server close:', err);
          reject(err);
        } else {
          this.Log.info('Server closed successfully');
          resolve();
        }
      });

      // For tracked connections, manually close them after grace period
      setTimeout(() => {
        if (this._connections.size > 0) {
          this.Log.warn(`Forcing closure of ${this._connections.size} remaining connections`);
          this._forceCloseConnections();
        }
      }, 5000);
    });
  }

  /**
   * Force close all tracked connections
   */
  private _forceCloseConnections(): void {
    for (const connection of this._connections) {
      try {
        connection.destroy();
      } catch (err) {
        this.Log.warn('Error destroying connection:', err.message);
      }
    }
    this._connections.clear();
  }

  /**
   * Registers global middleware to express app
   *
   * @param middleware - middleware function
   */
  public use(middleware: RequestHandler | ErrorRequestHandler): void {
    this.Express.use(middleware);
  }
}
