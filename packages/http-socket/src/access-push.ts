import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { AUTHZ_CHANGED_EVENT, AccessPushTransport, principalKey } from '@spinajs/authz';
import type { AccessChangedEvent, Principal } from '@spinajs/authz';
import { BaseSocketController } from './controller.js';
import { Connection, OnConnect, SocketController } from './decorators.js';
import { SocketConnection } from './connection.js';
import { SocketHub } from './hub.js';

export const ACCESS_PUSH_ROOM_PREFIX = 'principal:';

export function principalRoom(key: string): string {
  return `${ACCESS_PUSH_ROOM_PREFIX}${key}`;
}

/** The principal's room and those of the identities that speak with it (a link bearer's signed-in user). */
export function principalRooms(principal: Principal): string[] {
  return [...new Set([principal, ...(principal.companions ?? [])].map((p) => principalRoom(principalKey(p))))];
}

@SocketController('authz')
export class AccessPushSocket extends BaseSocketController {
  @OnConnect()
  public joinPrincipalRooms(@Connection() connection: SocketConnection): void {
    if (!connection.authenticated || !connection.principal.authenticated) {
      return;
    }

    connection.join(principalRooms(connection.principal));
  }
}

/** `authz.changed` to socket clients (design §10.4); fed by the root domain's AccessChangeRouter. */
@Singleton()
@Injectable(AccessPushTransport)
export class SocketAccessPushTransport extends AccessPushTransport {
  public readonly name = 'socket';

  @Autoinject()
  protected Hub: SocketHub;

  public async push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> {
    // empty also while the hub is detached, when toLocal() would throw
    if (this.Hub.Connections.size === 0) {
      return;
    }

    if (principals === '*') {
      for (const connection of this.Hub.Connections.values()) {
        connection.emit(AUTHZ_CHANGED_EVENT, event);
      }
      return;
    }

    if (principals.length > 0) {
      this.Hub.toLocal(principals.map(principalRoom)).emit(AUTHZ_CHANGED_EVENT, event);
    }
  }
}
