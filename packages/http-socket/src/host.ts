import { Server as HttpNodeServer } from 'http';
import { Server as HttpsNodeServer } from 'https';
import { DI, Injectable } from '@spinajs/di';
import { HttpServer } from '@spinajs/http';
import { SocketHttpHost } from './interfaces.js';

/** Default host: the http(s) server of `@spinajs/http`. Resolve SocketServer after HttpServer, before or after `start()`. */
@Injectable(SocketHttpHost)
export class HttpServerHost extends SocketHttpHost {
  public async server(): Promise<HttpNodeServer | HttpsNodeServer> {
    const http = await DI.resolve(HttpServer);
    return http.Server;
  }
}
