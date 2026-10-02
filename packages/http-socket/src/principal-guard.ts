import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Unauthenticated } from '@spinajs/authz';
import { ISocketAuthConfig, SocketPrincipalSource } from './interfaces.js';
import { SocketConnection } from './connection.js';

/** Re-checks the principal of a live connection ( D16 ). */
@Injectable()
export class SocketPrincipalGuard {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket.auth')
  protected Options: ISocketAuthConfig;

  @Autoinject(SocketPrincipalSource)
  protected Sources: SocketPrincipalSource[];

  protected pending = new WeakMap<SocketConnection, Promise<boolean>>();

  public async ensure(connection: SocketConnection): Promise<void> {
    const auth = connection.auth;

    if (auth.source === null) {
      return;
    }

    const expiresAt = auth.principal.ceiling?.expiresAt;
    // new Date(): a state restored through a serializing adapter carries the date as a string; NaN counts as expired
    if (expiresAt != null && !(new Date(expiresAt).getTime() > Date.now())) {
      this.refuse(connection, 'credentials expired');
    }

    if (this.Options.revalidateMs <= 0 || Date.now() - auth.checkedAt < this.Options.revalidateMs) {
      return;
    }

    let check = this.pending.get(connection);
    if (!check) {
      check = this.revalidate(connection).finally(() => this.pending.delete(connection));
      this.pending.set(connection, check);
    }

    if (!(await check)) {
      this.refuse(connection, 'credentials are no longer valid');
    }
  }

  protected async revalidate(connection: SocketConnection): Promise<boolean> {
    const source = this.Sources.find((s) => s.name === connection.auth.source);
    if (!source) {
      return false;
    }

    let valid: boolean;
    try {
      valid = await source.revalidate(connection.handshake, connection.principal);
    } catch (err) {
      this.Log.warn(err as Error, `Socket ${connection.id}: source ${source.name} could not revalidate its principal; refusing it`);
      return false;
    }

    if (valid) {
      connection.auth.checkedAt = Date.now();
    }

    return valid;
  }

  protected refuse(connection: SocketConnection, message: string): never {
    // setImmediate: the reply carrying this refusal is written first ( it goes out in a microtask )
    setImmediate(() => {
      if (connection.connected) {
        connection.disconnect('unauthenticated');
      }
    });

    throw new Unauthenticated(message);
  }
}
