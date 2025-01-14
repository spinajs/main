import { Log, Logger } from '@spinajs/log-common';
import { SocketServerMiddleware } from './interfaces.js';
import { Socket } from 'socket.io';
import { Injectable } from '@spinajs/di';

@Injectable(SocketServerMiddleware)
export class ConnectionLogMiddleware extends SocketServerMiddleware {
  // always first
  public get Order() {
    return 0;
  }

  @Logger('web-socket')
  protected Log: Log;

  public async before(_socket: Socket): Promise<void> {}
  public async onConnect(socket: Socket): Promise<void> {
    this.Log.trace(`Connected to new websocket, id: ${socket.id}, handshake: ${JSON.stringify(socket.handshake)}`);
  }
  public async onDisconnect(socket: Socket, reason: string): Promise<void> {
    this.Log.trace(`Disconnected socket, reason: ${reason}, id: ${socket.id}`);
  }
}
