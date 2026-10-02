import { Server } from 'socket.io';
import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DisconnectNotice, EventFrame, MAX_NAME_LENGTH, NAME_PATTERN, SYSTEM_EVENTS, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { SocketConnection } from './connection.js';
import { SocketPrincipalGuard } from './principal-guard.js';

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

  protected io: Server | null = null;
  protected connections = new Map<string, SocketConnection>();

  public attach(io: Server): void {
    this.io = io;
  }

  public detach(): void {
    this.io = null;
    this.connections.clear();
  }

  public register(connection: SocketConnection): void {
    this.connections.set(connection.id, connection);
  }

  public unregister(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /** A connection held by THIS instance; undefined for unknown ids or connections on other instances. */
  public connection(connectionId: string): SocketConnection | undefined {
    return this.connections.get(connectionId);
  }

  public get Connections(): ReadonlyMap<string, SocketConnection> {
    return this.connections;
  }

  public to(room: string | string[]): ISocketEmitter {
    const io = this.server();

    return {
      emit: <P>(name: string, payload: P) => {
        if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
          throw new InvalidArgument(`Pushed event name must match ${NAME_PATTERN} and be at most ${MAX_NAME_LENGTH} characters`);
        }

        const frame: EventFrame<P> = { name, payload };
        const closing = this.closingIds();
        (closing.length > 0 ? io.to(room).except(closing) : io.to(room)).emit(WIRE_EVENTS.event, frame);
      },
    };
  }

  /** Every socket.io connection is in a room named after its id. */
  public toConnection(connectionId: string): ISocketEmitter {
    return this.to(connectionId);
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

  /** Tells the client why, then closes. A server-side disconnect stops socket.io's auto-reconnect. */
  public disconnect(connectionId: string, reason: string): void {
    const io = this.server();
    const frame: EventFrame<DisconnectNotice> = { name: SYSTEM_EVENTS.disconnect, payload: { reason } };

    io.to(connectionId).emit(WIRE_EVENTS.event, frame);
    io.in(connectionId).disconnectSockets(false);
  }

  protected closingIds(): string[] {
    const ids: string[] = [];
    for (const connection of this.connections.values()) {
      if (this.Guard.isClosing(connection)) {
        ids.push(connection.id);
      }
    }
    return ids;
  }

  protected server(): Server {
    if (!this.io) {
      throw new InvalidOperation('SocketHub is not attached; resolve SocketServer first');
    }

    return this.io;
  }
}
