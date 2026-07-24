import { AsyncService, IContainer, Autoinject, Injectable, Container, Inject, DI } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { fsNative, IFsLocalOptions } from '@spinajs/fs';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-pug';

import { Server as Http, createServer as HttpCreateServer } from 'http';
import { Server as Https, createServer as HttpsCreateServer } from 'https';
import { existsSync } from 'fs';
import Express, { ErrorRequestHandler, RequestHandler } from 'express';
import _ from 'lodash';
import fs from 'fs';

import { ServerMiddleware, IHttpServerConfiguration, LifecycleState } from './interfaces.js';
import './transformers/index.js';
import './middlewares/ResponseTime.js';
import './middlewares/RequestId.js';
import './middlewares/RealIp.js';
import './middlewares/ReqStorage.js';
import './middlewares/NotFound.js';
import './middlewares/ErrorHandler.js';
import './middlewares/AccessLog.js';
import './middlewares/Compression.js';
import './middlewares/Cors.js';
import './middlewares/SlowRequestWarning.js';
import './middlewares/ServerTiming.js';

@Injectable()
@Inject(Templates)
export class HttpServer extends AsyncService {
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(ServerMiddleware)
  protected Middlewares!: ServerMiddleware[];

  @Config('http')
  protected HttpConfig!: IHttpServerConfiguration;

  @Config('https')
  protected HttpsEnabled!: boolean;

  @Config('process.env.APP_ENV', {
    defaultValue: 'development',
  })
  protected AppEnv!: string;

  @Config('http.shutdownTimeout', {
    defaultValue: 10000,
  })
  protected ShutdownTimeout!: number;

  /**
   * Express app instance
   */
  protected Express!: Express.Express;

  /**
   * Http socket server
   */
  protected _httpServer!: Http;
  protected _httpsServer!: Https;

  /**
   * Track active connections for cleanup
   */
  protected _connections = new Set<any>();

  /**
   * Lifecycle state. All three public entry points ( start / stop / dispose )
   * transition through it so double-close, restart and idempotency are decided
   * in one place.
   */
  protected _state: LifecycleState = LifecycleState.Created;

  /**
   * The in-flight close promise, so concurrent / repeated stop() calls share one
   * shutdown rather than each issuing a second Server.close().
   */
  protected _closePromise: Promise<void> | null = null;

  /**
   * After-middlewares ( NotFound / ErrorHandler / ServerTiming ... ) attach to
   * the Express app exactly once per instance. Restart must not re-stack them.
   */
  protected _afterAttached = false;

  public get State(): LifecycleState {
    return this._state;
  }

  public get Server(): Http | Https {
    return this.HttpsEnabled ? this._httpsServer : this._httpServer;
  }

  /**
   * Logger for this module
   */
  @Logger('http')
  protected Log!: Log;

  constructor() {
    super();
  }

  public async resolve(): Promise<void> {

    await super.resolve();

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

    this.HttpConfig.middlewares?.forEach((m) => {
      this.Log.info(`Using server middleware::before() - ${m.constructor.name}`);
      this.use(m);
    });

    // CORS is now provided by CorsMiddleware (registered as ServerMiddleware,
    // applied through the standard `Middlewares.before()` loop below).

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

      // Persistent, log-only 'error' handler attached once per server ( same place
      // as 'connection', so it never accumulates ). start()'s per-start .once is
      // removed on listen success, so without this a server-level 'error' emitted
      // AFTER listening would be unhandled and crash the process.
      this._httpsServer.on('error', (err: any) => {
        this.Log.error(`Server error: ${err?.message ?? err}`);
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

      // Persistent, log-only 'error' handler attached once per server ( same place
      // as 'connection', so it never accumulates ). start()'s per-start .once is
      // removed on listen success, so without this a server-level 'error' emitted
      // AFTER listening would be unhandled and crash the process.
      this._httpServer.on('error', (err: any) => {
        this.Log.error(`Server error: ${err?.message ?? err}`);
      });
    }
  }

  /**
   * Server static files
   */
  private _serverStaticFiles() {
    // uniqBy Path — Static entries are objects, so plain _.uniq (reference
    // equality) would never dedupe two config entries pointing at the same dir.
    _.uniqBy(this.HttpConfig.Static, (s) => s.Path).forEach((s) => {
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
  public async start(): Promise<void> {
    // Idempotent: already serving -> nothing to do. This is what stops a
    // repeated start() ( HttpServer is a DI singleton ) re-stacking middleware.
    if (this._state === LifecycleState.Listening) {
      return;
    }

    // A start() racing a shutdown waits for the close to finish, then re-listens.
    if (this._state === LifecycleState.Closing && this._closePromise) {
      await this._closePromise;
    }

    // add all after-middlewares once per instance ( not once per start ).
    if (!this._afterAttached) {
      // Copy before reversing so we don't mutate the shared, already-sorted
      // Middlewares array in place.
      [...this.Middlewares].reverse().forEach((m) => {
        const f = m.after();
        if (f) {
          this.Log.info(`Using server middleware::after() - ${m.constructor.name}`);
          this.use(f);
        }
      });
      this._afterAttached = true;
    }

    await new Promise<void>((res, rej) => {
      // .once, removed on success, so repeated start()/restart never accumulates
      // 'error' listeners on the reused server object.
      const onError = (err: any) => {
        if (err.code === 'EADDRINUSE') {
          this.Log.error(`----- Port ${this.HttpConfig.port} is busy -----`);
        }
        rej(err);
      };
      this.Server.once('error', onError);

      this.Server.listen(this.HttpConfig.port, () => {
        this.Server.removeListener('error', onError);
        this._state = LifecycleState.Listening;
        this._emit('http.server.listening');
        this.Log.info(`Server started at port ${this.HttpConfig.port}`);
        res();
      });
    });
  }

  /**
   * Emit a lifecycle event on the DI bus, isolating the state machine from a
   * throwing subscriber. Container.emit is synchronous, so without this guard a
   * listener that throws would pre-empt the caller - eg. a throwing
   * `http.server.listening` listener runs before res() and would hang start(),
   * and a throwing `http.server.closing` listener would escape stop().
   */
  protected _emit(event: string): void {
    try {
      this.Container.emit(event, this);
    } catch (err: any) {
      this.Log.warn(`Listener for ${event} threw: ${err?.message ?? err}`);
    }
  }

  public stop(): Promise<void> {
    return this._close();
  }

  /**
   * AsyncService teardown. HttpServer holds no resources beyond the socket
   * server and its tracked connections, both released by stop(); this awaits it.
   */
  public async dispose(): Promise<void> {
    await this.stop();
  }

  /**
   * Single shutdown path for both stop() and dispose(). Idempotent: repeated or
   * concurrent calls share one Server.close() instead of issuing a second one
   * ( which would reject with ERR_SERVER_NOT_RUNNING ).
   */
  protected _close(): Promise<void> {
    if (this._state === LifecycleState.Closing) {
      return this._closePromise!;
    }

    if (this._state !== LifecycleState.Listening || !this.Server) {
      // Created or Closed - nothing to close
      return Promise.resolve();
    }

    this._state = LifecycleState.Closing;

    this._closePromise = new Promise<void>((resolve) => {
      // One watchdog, unref'd so it can never hold the event loop open, and
      // cleared on every close-callback path. The old code leaked a second,
      // never-cleared 5s timer here.
      const watchdog = setTimeout(() => {
        this.Log.warn('Server shutdown grace period expired, forcing connections closed');
        this.Server.closeAllConnections?.();
        this._forceCloseConnections();
      }, this.ShutdownTimeout);
      watchdog.unref();

      this.Server.close((err) => {
        clearTimeout(watchdog);
        this._forceCloseConnections();
        this._state = LifecycleState.Closed;

        if (err) {
          // Unexpected given the guards above; log rather than reject so shutdown
          // always settles.
          this.Log.warn(`Error during server close: ${err.message}`);
        }

        this._emit('http.server.closed');
        resolve();
      });

      // Free IDLE keep-alive sockets right away so the port releases promptly,
      // while any in-flight request keeps the grace window above.
      this.Server.closeIdleConnections?.();
    });

    // Emit AFTER _closePromise is assigned. Container.emit is fully synchronous,
    // so a listener that re-enters stop() during this emit hits the Closing guard
    // and must find the shared promise already in place ( emitting before the
    // assignment would hand that re-entrant caller a null instead of a thenable ).
    this._emit('http.server.closing');

    return this._closePromise;
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
