import { HttpServer } from '@spinajs/http';
import { AsyncService, Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';

import { Server } from 'socket.io';
import { SocketController, SocketServerMiddleware } from './interfaces.js';

import './middlewares.js';

export class WebsocketServer extends AsyncService {
  /**
   * Logger for this module
   */
  @Logger('websocket')
  protected Log: Log;

  @Autoinject()
  protected HttpServer: HttpServer;

  protected Server: Server;

  @Autoinject(SocketServerMiddleware)
  protected Middlewares: SocketServerMiddleware[];

  @Autoinject(SocketController)
  protected Controllers: SocketController[];

  public async resolve(): Promise<void> {

    await super.resolve();

    this.Server = new Server(this.HttpServer.Server);

    this.Middlewares.sort((a, b) => {
      return a.Order < b.Order ? -1 : a.Order > b.Order ? 1 : 0;
    });

    this.Middlewares.forEach((m) => {
      this.Server.use((socket, next) => {
        m.before(socket)
          .then(() => next())
          .catch((err) => next(err));
      });
    });

    this.Server.on('connection', async (socket) => {
      for (const m of this.Middlewares) {
        await m.onConnect(socket);

        socket.on('disconnet', async (reason) => {
          await m.onDisconnect(socket, reason);
        });
      }

      for (const c of this.Controllers) {
        await c.attach(socket);
      }
    });
  }
}
