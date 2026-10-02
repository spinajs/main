import { Server } from 'socket.io';
import { Injectable } from '@spinajs/di';
import { SocketConnection } from './connection.js';

@Injectable()
export class SocketHub {
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
}
