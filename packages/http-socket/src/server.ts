import type { EventEmitter } from 'events';
import { Server, ServerOptions, Socket } from 'socket.io';
import { AsyncService, Autoinject, ClassInfo, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ListFromFiles } from '@spinajs/reflection';
import { UNATTENDED, Unauthenticated } from '@spinajs/authz';
import { DisconnectNotice, EventFrame, MAX_ID_LENGTH, PROTOCOL_VERSION, SYSTEM_EVENTS, SocketError, SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { ISocketAuthState, ISocketClientState, ISocketHandshake, ISocketServerConfig, SocketHttpHost, SocketPrincipalSource } from './interfaces.js';
import { SocketConnection, toHandshake } from './connection.js';
import { SocketDispatcher } from './dispatcher.js';
import { SocketErrorMapper } from './errors.js';
import { SocketHub } from './hub.js';
import { crossSiteRefusal, isAllowedOrigin } from './origin.js';
import { SocketHandlerRegistry } from './registry.js';
import './host.js';
import './authn-source.js';

/** socket.io hands `data` to the client as the `connect_error` payload. */
function refusal(wire: SocketError): Error & { data: SocketError } {
  const err = new Error(wire.message) as Error & { data: SocketError };
  err.data = wire;
  return err;
}

type Listener = (...args: unknown[]) => void;

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

  // Loading the files is what runs their @SocketController decorators.
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.socketControllers')
  protected ControllerFiles: Promise<Array<ClassInfo<unknown>>>;

  protected _io: Server | null = null;

  protected releaseHost: (() => void) | null = null;

  /** Built once per socket by the handshake middleware and handed to its SocketConnection. */
  protected handshakes = new WeakMap<Socket, ISocketHandshake>();

  public get Io(): Server | null {
    return this._io;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    await this.ControllerFiles;
    // a duplicate or orphan handler rejects here, before socket.io attaches: no partial routing
    await this.Registry.build();

    const http = await this.Host.server();
    const { io, release } = attachTo(http, () => new Server(http, this.ioOptions()));
    this.releaseHost = release;

    io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (err: Error) => next(err),
      );
    });
    io.on('connection', (socket) => this.onConnection(socket));

    this.Hub.attach(io);
    this._io = io;
  }

  public async dispose(): Promise<void> {
    const io = this._io;
    if (!io) {
      return;
    }

    this._io = null;
    this.Dispatcher.abortAll(new SocketException('unavailable', 'server is shutting down'));
    io.disconnectSockets(true);
    // not io.close(): that also closes the http server, which the host owns
    await Promise.allSettled([...io._nsps.values()].map((nsp) => nsp.adapter.close()));
    io.engine.close();
    this.releaseHost?.();
    this.releaseHost = null;
    this.Hub.detach();
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

  protected async authenticate(socket: Socket): Promise<void> {
    try {
      // first: no principal source may read the credentials of a hijacked cross-site socket
      if (!isAllowedOrigin(socket.handshake.headers, this.Options.cors.origins, socket.handshake.secure)) {
        throw new SocketException('forbidden', 'origin not allowed');
      }

      const handshake = toHandshake(socket);
      const auth = handshake.auth;

      if (auth.protocol !== PROTOCOL_VERSION) {
        throw new SocketException('version_mismatch', `server speaks protocol ${PROTOCOL_VERSION}, client sent ${String(auth.protocol)}`, { details: { server: PROTOCOL_VERSION } });
      }

      if (typeof auth.clientId !== 'string' || auth.clientId.length === 0) {
        throw new SocketException('invalid_argument', 'handshake auth.clientId must be a non-empty string');
      }

      if (auth.clientId.length > MAX_ID_LENGTH) {
        throw new SocketException('invalid_argument', `handshake auth.clientId is longer than ${MAX_ID_LENGTH} characters`);
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

    this.Hub.register(connection);
    this.Dispatcher.attach(connection, socket);

    socket.on('disconnect', (reason: string) => {
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
