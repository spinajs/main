import { BaseSocketController, Command, FromDI, OnConnect, OnEvent, Payload, SocketController } from '@spinajs/http-socket';
import { Db } from './services.js';

export class Hello {}

export abstract class CrudSocket extends BaseSocketController {
  @Command('save')
  public save(@Payload() item: Hello, @FromDI() db: Db) {
    return [item, db];
  }

  @OnEvent('touched')
  public touched(@Payload() item: Hello) {
    return item;
  }
}

@SocketController('things')
export class ThingsSocket extends CrudSocket {}

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
