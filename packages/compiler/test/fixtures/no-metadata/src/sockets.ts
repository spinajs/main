import { BaseSocketController, Command, FromDI, OnConnect, OnEvent, Payload, SocketController } from '@spinajs/http-socket';
import { Db } from './services.js';

export class Hello {}

@SocketController('docs')
export class DocsSocket extends BaseSocketController {
  @Command()
  public open(@Payload() hello: Hello, @FromDI() db: Db) {
    return [hello, db];
  }

  @OnEvent('seen')
  public seen(@FromDI() db: Db) {
    return db;
  }

  @OnConnect()
  public connected(@FromDI() db: Db) {
    return db;
  }
}
