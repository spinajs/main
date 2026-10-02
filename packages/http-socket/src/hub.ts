import { Server } from 'socket.io';
import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DisconnectNotice, EventFrame, SYSTEM_EVENTS, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { SocketConnection } from './connection.js';
import { SocketPrincipalGuard } from './principal-guard.js';
import { assertPushName } from './push-name.js';
import { ISocketServerConfig } from './interfaces.js';

export interface ISocketEmitter {
  emit<P>(name: string, payload: P): void;
}

/**
 * Server-side push and rooms. Joining or leaving a room is a server decision; clients ask through
 * ordinary commands. Everything addressed by room or connection id also reaches connections on
 * other instances when a socket.io adapter is configured; `connection()` sees only local ones.
 * Pushes skip local connections the principal guard is closing.
 */
@Injectable()
export class SocketHub {
  @Autoinject(SocketPrincipalGuard)
  protected Guard: SocketPrincipalGuard;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  protected io: Server | null = null;
  protected connections = new Map<string, SocketConnection>();

  /** @internal called by SocketServer */
  public attach(io: Server): void {
    this.io = io;
  }

  /** @internal called by SocketServer */
  public detach(): void {
    this.io = null;
    this.connections.clear();
  }

  /** @internal called by SocketServer */
  public register(connection: SocketConnection): void {
    this.connections.set(connection.id, connection);
  }

  /** @internal called by SocketServer */
  public unregister(connectionId: string): void {
    this.connections.delete(connectionId);
    this.Guard.release(connectionId);
  }

  /** A connection held by THIS instance; undefined for unknown ids or connections on other instances. */
  public connection(connectionId: string): SocketConnection | undefined {
    return this.connections.get(connectionId);
  }

  public get Connections(): ReadonlyMap<string, SocketConnection> {
    return this.connections;
  }

  /** Rooms must be non-empty: socket.io treats an empty room set as every socket. */
  public to(room: string | string[]): ISocketEmitter {
    this.server();

    const rooms = Array.isArray(room) ? room : [room];
    if (rooms.length === 0 || rooms.some((r) => typeof r !== 'string' || r.length === 0)) {
      throw new InvalidArgument('Push target must be a non-empty room name or a non-empty list of them');
    }

    return {
      emit: <P>(name: string, payload: P) => {
        assertPushName(name);
        this.push(rooms, name, payload);
      },
    };
  }

  /**
   * `connectionId` is a socket id, which socket.io also uses as a room name. Without an adapter an id this
   * instance does not hold is dropped instead of being sent to a room that cannot exist.
   */
  public toConnection(connectionId: string): ISocketEmitter {
    const emitter = this.to(connectionId);

    if (!this.Options.adapter && !this.connections.has(connectionId)) {
      return { emit: (name: string) => assertPushName(name) };
    }

    return emitter;
  }

  public join(connectionId: string, room: string | string[]): void {
    this.server().in(connectionId).socketsJoin(room);
  }

  public leave(connectionId: string, room: string): void {
    this.server().in(connectionId).socketsLeave(room);
  }

  public async connectionsIn(room: string): Promise<string[]> {
    const sockets = await this.server().in(room).fetchSockets();
    return sockets.map((s) => s.id);
  }

  /** Tells the client why, then closes; `connectionId` is a socket id. A server-side disconnect stops socket.io's auto-reconnect. */
  public disconnect(connectionId: string, reason: string): void {
    const io = this.server();
    const frame: EventFrame<DisconnectNotice> = { name: SYSTEM_EVENTS.disconnect, payload: { reason } };

    io.to(connectionId).emit(WIRE_EVENTS.event, frame);
    io.in(connectionId).disconnectSockets(false);
  }

  protected push<P>(rooms: string[], name: string, payload: P): void {
    const frame: EventFrame<P> = { name, payload };
    const target = this.server().to(rooms);
    const closing = this.Guard.ClosingIds;

    (closing.size > 0 ? target.except([...closing]) : target).emit(WIRE_EVENTS.event, frame);
  }

  protected server(): Server {
    if (!this.io) {
      throw new InvalidOperation('SocketHub is not attached; resolve SocketServer first');
    }

    return this.io;
  }
}
