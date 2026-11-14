import { AsyncService, IContainer, Autoinject, Injectable, Container, Inject } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';
import { fsNative, getFs, IFsLocalOptions } from '@spinajs/fs';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-pug';

import { Server as Http, createServer as HttpCreateServer } from 'http';
import { Server as Https, createServer as HttpsCreateServer } from 'https';
import Express, { ErrorRequestHandler, RequestHandler } from 'express';
import fs from 'fs';

import { ServerMiddleware, IHttpServerConfiguration, LifecycleState, Request } from './interfaces.js';
import type { IActionLocalStoregeContext, Response } from './interfaces.js';
import { createBodyLimitMiddleware } from './body-limits.js';
import { missingDefaultMiddlewares } from './default-middlewares.js';
import { __handle_error__ } from './error.js';
import { deliverReply, lookUpRoutesIn } from './reply-pipeline.js';
import type { ErrorReplier } from './reply-pipeline.js';
import { globalErrorReplier, refuseRemovedHooks, serverMiddlewareHandlers } from './server-middlewares.js';
import { RouteIndex } from './route-index.js';
import { NotFoundMiddleware } from './middlewares/NotFound.js';
import { ErrorHandlerMiddleware } from './middlewares/ErrorHandler.js';
import './transformers/index.js';
import './middlewares/ResponseTime.js';
import './middlewares/RequestId.js';
import './middlewares/RealIp.js';
import './middlewares/ReqStorage.js';
import './middlewares/AccessLog.js';
import './middlewares/Compression.js';
import './middlewares/Cors.js';
import './middlewares/SlowRequestWarning.js';
import './middlewares/ServerTiming.js';
import './middlewares/StaticFiles.js';
import { limitsBeforeMiddlewares } from './middlewares/BodyParsers.js';

@Injectable()
@Inject(Templates)
export class HttpServer extends AsyncService {
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(ServerMiddleware)
  protected Middlewares!: ServerMiddleware[];

  /** The routes the controllers registered; server middlewares get the match before routing. */
  @Autoinject(RouteIndex)
  protected Routes!: RouteIndex;

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
   * The tail ( the 404 and the global error answer ) attaches to the Express app exactly
   * once per instance. Restart must not re-stack it.
   */
  protected _afterAttached = false;

  protected NotFound!: NotFoundMiddleware;

  protected ErrorHandler!: ErrorHandlerMiddleware;

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

  // An app's list replaces the shipped one, which drops the security headers without an error.
  private warnLostDefaults() {
    const missing = missingDefaultMiddlewares(this.HttpConfig.middlewares ?? []);
    if (missing.length === 0) return;

    this.Log.warn(
      { missing: missing.join(', ') },
      'http.middlewares does not hold the shipped ${missing}. To keep the defaults use [...defaultMiddlewares(), yours] from @spinajs/http. Ignore this if your own handlers, such as your own helmet(), do that work.',
    );
  }

  public async resolve(): Promise<void> {

    await super.resolve();

    this.Express = Express();
    // Array.ofType lists instances in the order their async resolve() finished, not in registration order
    const registered = (this.Container.getRegisteredTypes(ServerMiddleware) ?? []) as unknown[];
    const index = new Map(this.Middlewares.map((m) => [m, registrationIndex(registered, m)]));
    // A copy: the injected array is the DI cache's own collection, which must stay in registration order
    this.Middlewares = [...this.Middlewares].sort((a, b) => a.Order - b.Order || index.get(a)! - index.get(b)!);
    this.NotFound = await this.Container.resolve(NotFoundMiddleware);
    this.ErrorHandler = await this.Container.resolve(ErrorHandlerMiddleware);
    [...this.Middlewares, this.NotFound, this.ErrorHandler].forEach(refuseRemovedHooks);

    this._createServer();

    const f = getFs('__fs_http_response_templates__') as fsNative<IFsLocalOptions>;
    if (!f) {
      this.Log.info(`No fs provider for __fs_http_response_templates__ registered, response templates will not be available.`);
    } else {
      this.Log.info({ path: f.Options.basePath }, 'Response templates path at ${path}');
    }

    // first, so a failure of an http.middlewares handler is answered with the request storage in place
    const routes = this.Routes;
    this.use((req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
      (req as Request).storage = {} as IActionLocalStoregeContext;
      lookUpRoutesIn(res, routes);
      next();
    });

    // A handler of the app's own might read the body: the limits must come before it. Otherwise BodyLimits mounts them.
    if (limitsBeforeMiddlewares(this.HttpConfig.middlewares)) {
      const bodyLimits = createBodyLimitMiddleware(this.HttpConfig.bodyLimits ?? [], { parsers: this.HttpConfig.bodyParsers });
      if (bodyLimits) {
        this.Log.info({ rules: this.HttpConfig.bodyLimits!.length }, 'Using per-path body limits ( ${rules} rules ) before http.middlewares');
        this.use(bodyLimits);
      }
    }

    this.HttpConfig.middlewares?.forEach((m) => {
      this.Log.info({ middleware: m.name || 'anonymous' }, 'Using http.middlewares handler ${middleware}');
      this.use(m);
    });
    this.warnLostDefaults();

    this._mountServerMiddlewares();
  }

  /** The reply a throwing server `onAfter` turns into: the global error answer's. */
  protected _errorReplier(req: Express.Request): ErrorReplier {
    return globalErrorReplier(this.ErrorHandler, req);
  }

  private _mountServerMiddlewares() {
    const options = { log: this.Log, container: this.Container, errorReply: (req: Express.Request) => this._errorReplier(req) };

    for (const m of this.Middlewares) {
      const name = m.constructor.name;

      if (!m.isEnabled()) {
        this.Log.info({ middleware: name }, 'Server middleware ${middleware} is disabled');
        continue;
      }

      const handlers = serverMiddlewareHandlers(m, options);
      if (handlers.length > 0) {
        this.Log.info({ middleware: name }, 'Using server middleware ${middleware}');
        handlers.forEach((h) => this.use(h));
      }
    }
  }

  /** The 404 and the global error answer, both sent through the reply pipeline. */
  private _attachTail() {
    const notFound = this.NotFound;
    const errorHandler = this.ErrorHandler;
    this.use((req: Request, res: Express.Response, next: Express.NextFunction) => {
      Promise.resolve()
        .then(() => notFound.reply(req))
        .then((answer) => {
          if (isResponse(answer)) {
            return deliverReply(req, res, answer, { container: this.Container, errorReply: this._errorReplier(req) });
          }
          // a replacement answering nothing still gets the framework's 404, not express's
          next(answer ?? (NotFoundMiddleware.prototype.reply.call(notFound, req) as Error));
          return undefined;
        })
        .catch(next);
    });
    this.use(__handle_error__(this.Container, (err, req) => errorHandler.reply(err, req as Request)));
  }

  /**
   * Create http or https server
   */
  private _createServer()  {
    if (this.HttpsEnabled) {
      this.Log.info({ keyFile: this.HttpConfig.ssl.key }, 'Using https key file ${keyFile}');
      this.Log.info({ certFile: this.HttpConfig.ssl.cert }, 'Using https cert file ${certFile}');

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
        this.Log.error({ error: err }, 'Server error');
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
        this.Log.error({ error: err }, 'Server error');
      });
    }
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

    // after the controllers' routers, which mount while HttpServer is resolved; once per instance, not once per start
    if (!this._afterAttached) {
      this._attachTail();
      this._afterAttached = true;
    }

    await new Promise<void>((res, rej) => {
      // .once, removed on success, so repeated start()/restart never accumulates
      // 'error' listeners on the reused server object.
      const onError = (err: any) => {
        if (err.code === 'EADDRINUSE') {
          this.Log.error({ port: this.HttpConfig.port }, '----- Port ${port} is busy -----');
        }
        rej(err);
      };
      this.Server.once('error', onError);

      this.Server.listen(this.HttpConfig.port, () => {
        this.Server.removeListener('error', onError);
        this._state = LifecycleState.Listening;
        this._emit('http.server.listening');
        if (this.Routes.unmounted) {
          this.Log.warn('Controllers registered routes but no controllers router was mounted in the RouteIndex: server middlewares get no ctx.route before routing, @Cors routes keep the global CORS policy and @CsrfExempt() exempts nothing.');
        }
        this.Log.info({ port: this.HttpConfig.port }, 'Server started at port ${port}');
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
      this.Log.warn({ event, error: err }, 'Listener for ${event} threw');
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
          this.Log.warn({ error: err }, 'Error during server close');
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
        this.Log.warn({ error: err }, 'Error destroying connection');
      }
    }
    this._connections.clear();
  }

  /**
   * Registers global middleware to express app
   *
   * @param middleware - middleware function
   */
  /** ServerMiddleware handlers take the http `Request`; its `storage` is added by the first handler HttpServer mounts. */
  public use(middleware: RequestHandler | ErrorRequestHandler | ((req: Request, res: Express.Response, next: Express.NextFunction) => void)): void {
    this.Express.use(middleware as RequestHandler | ErrorRequestHandler);
  }
}

const isResponse = (value: unknown): value is Response => typeof (value as Response | null | undefined)?.execute === 'function';

/** An instance of a class that replaces a registered one ( `@Injectable(RealIp)` ) takes that one's place. */
function registrationIndex(registered: unknown[], m: ServerMiddleware): number {
  const own = registered.indexOf(m.constructor);
  if (own !== -1) return own;

  const replaced = registered.findIndex((t) => typeof t === 'function' && typeof t.prototype === 'object' && m instanceof t);
  return replaced === -1 ? registered.length : replaced;
}
