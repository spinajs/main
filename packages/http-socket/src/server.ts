import { Server, ServerOptions, Socket } from 'socket.io';
import { AsyncService, Autoinject, ClassInfo, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ListFromFiles } from '@spinajs/reflection';
import { UNATTENDED, Unauthenticated } from '@spinajs/authz';
import { MAX_ID_LENGTH, PROTOCOL_VERSION, SocketError, SocketException } from '@spinajs/http-socket-common';
import { ISocketAuthState, ISocketServerConfig, SocketHttpHost, SocketPrincipalSource } from './interfaces.js';
import { SocketConnection, toHandshake } from './connection.js';
import { SocketErrorMapper } from './errors.js';
import { SocketHub } from './hub.js';
import { isAllowedOrigin } from './origin.js';
import './host.js';
import './authn-source.js';

/** socket.io hands `data` to the client as the `connect_error` payload. */
function refusal(wire: SocketError): Error & { data: SocketError } {
  const err = new Error(wire.message) as Error & { data: SocketError };
  err.data = wire;
  return err;
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

  @Autoinject(SocketPrincipalSource)
  protected Sources: SocketPrincipalSource[];

  // Loading the files is what runs their @SocketController decorators.
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.socketControllers')
  protected ControllerFiles: Promise<Array<ClassInfo<unknown>>>;

  protected _io: Server | null = null;

  public get Io(): Server | null {
    return this._io;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    await this.ControllerFiles;

    const io = new Server(await this.Host.server(), this.ioOptions());
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
    io.disconnectSockets(true);
    io.engine.close();
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
    };

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
      if (!isAllowedOrigin(socket.handshake.headers, this.Options.cors.origins)) {
        throw new SocketException('forbidden', 'origin not allowed');
      }

      const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;

      if (auth.protocol !== PROTOCOL_VERSION) {
        throw new SocketException('version_mismatch', `server speaks protocol ${PROTOCOL_VERSION}, client sent ${String(auth.protocol)}`, { details: { server: PROTOCOL_VERSION } });
      }

      if (typeof auth.clientId !== 'string' || auth.clientId.length === 0 || auth.clientId.length > MAX_ID_LENGTH) {
        throw new SocketException('invalid_argument', 'handshake auth.clientId must be a non-empty string');
      }

      socket.data.auth = await this.identify(socket);
    } catch (err) {
      const wire = this.Errors.toWire(err, 'handshake');
      this.Log.debug(`Socket handshake refused: ${wire.code} ${wire.message}`);
      throw refusal(wire);
    }
  }

  protected async identify(socket: Socket): Promise<ISocketAuthState> {
    const handshake = toHandshake(socket);
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
    const connection = new SocketConnection(socket, toHandshake(socket));
    this.Hub.register(connection);

    socket.on('disconnect', (reason: string) => {
      connection.close(reason);
      this.Hub.unregister(connection.id);
    });
  }
}
