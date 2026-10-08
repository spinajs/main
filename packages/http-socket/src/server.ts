import type { EventEmitter } from 'events';
import { Namespace, Server, ServerOptions, Socket } from 'socket.io';
import { AsyncService, Autoinject, ClassInfo, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ListFromFiles } from '@spinajs/reflection';
import { AuthzConfigError, UNATTENDED, Unauthenticated } from '@spinajs/authz';
import { DisconnectNotice, EventFrame, MAX_ID_LENGTH, PROTOCOL_VERSION, SYSTEM_EVENTS, ShutdownNotice, SocketError, SocketException, WIRE_EVENTS, isId } from '@spinajs/http-socket-common';
import { ISocketAuthState, ISocketClientState, ISocketHandshake, ISocketServerConfig, SocketHttpHost, SocketPrincipalSource } from './interfaces.js';
import { SocketConnection, toHandshake } from './connection.js';
import { SocketDispatcher } from './dispatcher.js';
import { SocketErrorMapper } from './errors.js';
import { SocketHub } from './hub.js';
import { SocketPrincipalGuard } from './principal-guard.js';
import { crossSiteRefusal, isAllowedOrigin } from './origin.js';
import { SocketHandlerRegistry } from './registry.js';
import { trackConnection } from './metrics.js';
import './host.js';
import './authn-source.js';
import { assertIdempotencyConfig, outcomeUnknownAfter } from './idempotency.js';
import { SHUTDOWN_FLUSH_MS, assertShutdownConfig, shutdownOverrun } from './limits.js';

/** socket.io hands `data` to the client as the `connect_error` payload. */
function refusal(wire: SocketError): Error & { data: SocketError } {
  const err = new Error(wire.message) as Error & { data: SocketError };
  err.data = wire;
  return err;
}

type Listener = (...args: unknown[]) => void;

/**
 * A closing engine.io connection writes its buffered packets before it closes its transport, but `engine.close()`
 * discards them: waiting here keeps the last replies, stream frames and disconnect packets.
 */
function transportsClosed(transports: Array<Socket['conn']>, ms: number): Promise<boolean> {
  const open = transports.filter((conn) => conn.readyState !== 'closed');
  return within(
    open.map((conn) => new Promise<void>((resolve) => conn.once('close', () => resolve()))),
    ms,
  );
}

/** True once every promise settled; false when `ms` passes first. */
function within(work: Array<Promise<unknown>>, ms: number): Promise<boolean> {
  if (work.length === 0) {
    return Promise.resolve(true);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });

  return Promise.race([Promise.all(work).then(() => true), timeout]).finally(() => clearTimeout(timer));
}

const HOST_EVENTS = ['request', 'upgrade', 'close', 'listening'] as const;

/**
 * engine.io and socket.io's client file server take over `request` ( removing what was there and
 * calling it themselves ) and add listeners of their own. The returned function undoes exactly
 * that on a server this package does not own, so it keeps serving after `dispose()`.
 */
function attachTo(http: EventEmitter, attach: () => Server): { io: Server; release: () => void } {
  const before = new Map(HOST_EVENTS.map((event) => [event, http.listeners(event) as Listener[]]));
  const io = attach();
  const after = new Map(HOST_EVENTS.map((event) => [event, http.listeners(event) as Listener[]]));

  const release = () => {
    for (const event of HOST_EVENTS) {
      const was = before.get(event)!;
      const added = after.get(event)!.filter((l) => !was.includes(l));
      added.forEach((l) => http.removeListener(event, l));

      const current = http.listeners(event);
      was.filter((l) => !current.includes(l)).forEach((l) => http.on(event, l));
    }
  };

  return { io, release };
}

@Injectable()
export class SocketServer extends AsyncService {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  /** `@spinajs/http`'s shutdown watchdog, with its default */
  @Config('http.shutdownTimeout', { defaultValue: 10_000 })
  protected HttpShutdownTimeout: number;

  @Autoinject()
  protected Host: SocketHttpHost;

  @Autoinject()
  protected Hub: SocketHub;

  @Autoinject()
  protected Errors: SocketErrorMapper;

  @Autoinject()
  protected Registry: SocketHandlerRegistry;

  @Autoinject()
  protected Dispatcher: SocketDispatcher;

  @Autoinject(SocketPrincipalSource)
  protected Sources: SocketPrincipalSource[];

  @Autoinject()
  protected Guard: SocketPrincipalGuard;

  // Loading the files is what runs their @SocketController decorators.
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.socketControllers')
  protected ControllerFiles: Promise<Array<ClassInfo<unknown>>>;

  protected _io: Server | null = null;

  protected releaseHost: (() => void) | null = null;

  /** Built once per socket by the handshake middleware and handed to its SocketConnection. */
  protected handshakes = new WeakMap<Socket, ISocketHandshake>();

  /** Set when shutdown starts; handshakes and recovered sockets are refused with it. */
  protected closing: SocketException | null = null;

  protected stopping: Promise<void> | null = null;

  /** the http server socket.io is attached to */
  protected http: EventEmitter | null = null;

  /** `@spinajs/http` emits it with the closing HttpServer; another server in the same container is not ours. */
  protected onHttpClosing = (closing?: unknown): void => {
    if ((closing as { Server?: unknown } | undefined)?.Server !== this.http) {
      return;
    }
    this.shutdown().catch((err: Error) => this.Log.error(err, 'Socket server shutdown failed'));
  };

  public get Io(): Server | null {
    return this._io;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    assertIdempotencyConfig(this.Options.idempotency);
    assertShutdownConfig(this.Options);
    const overrun = shutdownOverrun(this.Options.drainMs, this.HttpShutdownTimeout);
    if (overrun) {
      this.Log.warn(overrun);
    }
    await this.ControllerFiles;
    // a duplicate or orphan handler rejects here, before socket.io attaches: no partial routing
    await this.Registry.build();

    const http = await this.Host.server();
    this.http = http;
    const { io, release } = attachTo(http, () => new Server(http, this.ioOptions()));
    this.releaseHost = release;
    this.guardRecovery(io);

    io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (err: Error) => next(err),
      );
    });
    io.on('connection', (socket) => this.onConnection(socket));

    this.Hub.attach(io);
    this._io = io;
    this.Guard.start(() => this.Hub.Connections.values());
    DI.on('http.server.closing', this.onHttpClosing);
  }

  /**
   * Graceful shutdown ( spec §5.5 ): refuse new connections and commands, tell the clients when to come
   * back, let running commands and streams finish for up to `drainMs`, answer the rest `unavailable`, then close.
   * Also started by the http server's `http.server.closing`; idempotent.
   */
  public shutdown(): Promise<void> {
    return (this.stopping ??= this.drainAndClose());
  }

  public async dispose(): Promise<void> {
    await this.shutdown();
  }

  protected async drainAndClose(): Promise<void> {
    const io = this._io;
    if (!io) {
      return;
    }

    DI.off('http.server.closing', this.onHttpClosing);

    try {
      await this.drain(io);
    } finally {
      // only now: an earlier stop forgets the connections the guard is closing, which a recovery could then restore
      this.Guard.stop();
      // not io.close(): that also closes the http server, which the host owns
      await within(
        [...io._nsps.values()].map((nsp) =>
          Promise.resolve()
            .then(() => nsp.adapter.close())
            .catch((err: Error) => this.Log.warn(`Socket adapter close failed: ${err?.message}`)),
        ),
        SHUTDOWN_FLUSH_MS,
      );
      io.engine.close();
      this.releaseHost?.();
      this.releaseHost = null;
      this._io = null;
      this.Hub.detach();
    }
  }

  protected async drain(io: Server): Promise<void> {
    const retryAfterMs = this.Options.shutdownRetryAfterMs;
    const unavailable = outcomeUnknownAfter(new SocketException('unavailable', 'server is shutting down', { retryAfterMs }));
    this.closing = unavailable;
    this.Dispatcher.refuseNew(unavailable);

    // per connection, not io.emit: with an adapter that would reach the clients of the other instances
    for (const connection of this.Hub.Connections.values()) {
      connection.notify(SYSTEM_EVENTS.shutdown, this.shutdownNotice());
    }

    if (!(await this.Dispatcher.drained(this.Options.drainMs))) {
      this.Log.warn(`Socket commands still running after a ${this.Options.drainMs} ms drain are answered unavailable`);
      // a keyed handler that already runs may commit any moment: it gets a grace to answer, and record, its real outcome
      this.Dispatcher.abortAll(unavailable, true);

      if (!(await this.Dispatcher.drained(SHUTDOWN_FLUSH_MS))) {
        this.Dispatcher.abortAll(unavailable);
        // the abort answers at once, but the replies are written in later microtasks; closing first would drop them
        if (!(await this.Dispatcher.answered(SHUTDOWN_FLUSH_MS))) {
          this.Log.warn(`Socket replies still unwritten ${SHUTDOWN_FLUSH_MS} ms after the drain, closing anyway`);
        }
      }
    }

    const transports = [...io.of('/').sockets.values()].map((socket) => socket.conn);
    // local: with a cluster adapter, io.disconnectSockets would close the clients of every instance, and only later
    io.local.disconnectSockets(true);

    // disconnect hooks may still push to rooms, so the hub stays attached until they are done
    const [flushed, hooksDone] = await Promise.all([transportsClosed(transports, SHUTDOWN_FLUSH_MS), this.Dispatcher.hooksDone(this.Options.drainMs)]);
    if (!flushed) {
      this.Log.warn(`Socket transports still writing ${SHUTDOWN_FLUSH_MS} ms after the disconnect, closing anyway`);
    }
    if (!hooksDone) {
      this.Log.warn(`Socket disconnect hooks still running after ${this.Options.drainMs} ms, closing anyway`);
    }
  }

  protected shutdownNotice(): ShutdownNotice {
    return { retryAfterMs: this.Options.shutdownRetryAfterMs };
  }

  protected ioOptions(): Partial<ServerOptions> {
    const o = this.Options;
    const options: Partial<ServerOptions> = {
      path: o.path,
      pingInterval: o.pingInterval,
      pingTimeout: o.pingTimeout,
      // socket.io closes the whole connection on an oversized frame; the headroom lets the size
      // stage answer resource_exhausted for payloads up to twice the limit instead.
      maxHttpBufferSize: o.maxPayloadBytes * 2,
      allowRequest: (req, callback) => {
        let reason: string | null;
        try {
          reason = crossSiteRefusal(req.headers, req.url);
        } catch {
          reason = 'malformed request';
        }

        if (reason !== null) {
          this.Log.debug(`Socket transport request refused: ${reason}`);
        }
        callback(reason, reason === null);
      },
    };

    if (o.transports) {
      options.transports = [...o.transports];
    }

    if (o.cors.origins.length > 0) {
      options.cors = { origin: [...o.cors.origins], credentials: true };
    }

    if (o.adapter) {
      options.adapter = o.adapter as ServerOptions['adapter'];
    }

    if ((o.recovery?.maxDisconnectionMs ?? 0) > 0) {
      options.connectionStateRecovery = { maxDisconnectionDuration: o.recovery.maxDisconnectionMs, skipMiddlewares: true };
    }

    return options;
  }

  /**
   * socket.io writes a restored session's missed packets in the Socket constructor, before any middleware or
   * `connection` handler: an expired, due or revoked principal must be refused here, which forces a full handshake.
   */
  protected guardRecovery(io: Server): void {
    const nsp = io.of('/') as Namespace & { _initAdapter(): void };

    const wrap = () => {
      const adapter = nsp.adapter;
      const restore = adapter.restoreSession.bind(adapter);
      adapter.restoreSession = async (pid, offset) => {
        const session = await restore(pid, offset);
        return session && this.Guard.restorable(session.data) ? session : null;
      };
    };

    wrap();
    // io.adapter() replaces the adapter of every namespace through _initAdapter
    const init = nsp._initAdapter.bind(nsp);
    nsp._initAdapter = () => {
      init();
      wrap();
    };
  }

  protected async authenticate(socket: Socket): Promise<void> {
    try {
      if (this.closing) {
        throw this.closing;
      }

      // first: no principal source may read the credentials of a hijacked cross-site socket
      if (!isAllowedOrigin(socket.handshake.headers, this.Options.cors.origins, socket.handshake.secure)) {
        throw new SocketException('forbidden', 'origin not allowed');
      }

      const handshake = toHandshake(socket);
      const auth = handshake.auth;

      if (auth.protocol !== PROTOCOL_VERSION) {
        // the message is logged: a client string must not reach it
        const sent = typeof auth.protocol === 'number' ? String(auth.protocol) : 'no numeric protocol';
        throw new SocketException('version_mismatch', `server speaks protocol ${PROTOCOL_VERSION}, client sent ${sent}`, { details: { server: PROTOCOL_VERSION } });
      }

      if (typeof auth.clientId !== 'string' || auth.clientId.length === 0) {
        throw new SocketException('invalid_argument', 'handshake auth.clientId must be a non-empty string');
      }

      if (auth.clientId.length > MAX_ID_LENGTH) {
        throw new SocketException('invalid_argument', `handshake auth.clientId is longer than ${MAX_ID_LENGTH} characters`);
      }

      if (!isId(auth.clientId)) {
        throw new SocketException('invalid_argument', 'handshake auth.clientId must be printable ASCII');
      }

      const client: ISocketClientState = { clientId: auth.clientId, protocol: PROTOCOL_VERSION };
      socket.data.auth = await this.identify(handshake);
      socket.data.client = client;
      this.handshakes.set(socket, handshake);
    } catch (err) {
      const wire = this.Errors.toWire(err, 'handshake');
      this.Log.debug(`Socket handshake refused: ${wire.code} ${wire.message}`);
      throw refusal(wire);
    }
  }

  protected async identify(handshake: ISocketHandshake): Promise<ISocketAuthState> {
    const sources = [...this.Sources].sort((a, b) => a.order - b.order);

    for (const source of sources) {
      const principal = await source.authenticate(handshake);
      // no credential yields SYSTEM or UNATTENDED; authz-http's PrincipalMiddleware refuses them the same way ( design §14.1 )
      if (principal && (principal.type === 'system' || principal.type === 'unattended')) {
        throw new AuthzConfigError(`socket principal source ${source.name} returned a ${principal.type} principal`);
      }
      if (principal) {
        return { principal, source: source.name, checkedAt: Date.now() };
      }
    }

    if (this.Options.auth.required) {
      throw new Unauthenticated('authentication required');
    }

    return { principal: UNATTENDED, source: null, checkedAt: Date.now() };
  }

  protected onConnection(socket: Socket): void {
    const handshake = this.handshakes.get(socket) ?? toHandshake(socket);
    this.handshakes.delete(socket);

    // a recovered socket skipped the handshake middleware, and a handshake may have passed it just before shutdown began
    if (this.closing) {
      // a recovered client did not hear the notice the others got
      const frame: EventFrame<ShutdownNotice> = { name: SYSTEM_EVENTS.shutdown, payload: this.shutdownNotice() };
      socket.emit(WIRE_EVENTS.event, frame);
      this.refuseConnected(socket, this.closing.toWire());
      return;
    }

    let connection: SocketConnection;
    try {
      // a recovered socket skipped the handshake middleware: its new Origin is still checked, and
      // SocketConnection takes clientId, protocol and principal from the restored socket.data only
      if (socket.recovered && !isAllowedOrigin(socket.handshake.headers, this.Options.cors.origins, socket.handshake.secure)) {
        throw new SocketException('forbidden', 'origin not allowed');
      }

      connection = new SocketConnection(socket, handshake);
    } catch (err) {
      this.refuseConnected(socket, this.Errors.toWire(err, 'connection'));
      return;
    }

    const release = trackConnection();
    this.Hub.register(connection);
    this.Dispatcher.attach(connection, socket);

    socket.on('disconnect', (reason: string) => {
      release();
      connection.close(reason);
      this.Dispatcher.detach(connection, reason);
      this.Hub.unregister(connection.id);
    });
  }

  protected refuseConnected(socket: Socket, wire: SocketError): void {
    this.Log.warn(`Socket ${socket.id} refused after connecting: ${wire.code} ${wire.message}`);

    const frame: EventFrame<DisconnectNotice> = { name: SYSTEM_EVENTS.disconnect, payload: { reason: wire.code } };
    socket.emit(WIRE_EVENTS.event, frame);
    socket.disconnect(false);
  }
}
