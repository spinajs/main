import { Socket } from 'socket.io';
import type { Principal } from '@spinajs/authz';
import { DisconnectNotice, EventFrame, SYSTEM_EVENTS, SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { assertPushName } from './push-name.js';
import { ISocketAuthState, ISocketClientState, ISocketHandshake } from './interfaces.js';

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies = Object.create(null) as Record<string, string>;

  if (!header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }

    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();

    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    try {
      value = decodeURIComponent(value);
    } catch {
      // malformed escape: keep the raw value
    }

    if (!(name in cookies)) {
      cookies[name] = value;
    }
  }

  return cookies;
}

export function toHandshake(socket: Socket): ISocketHandshake {
  const h = socket.handshake;

  return {
    auth: { ...(h.auth as Record<string, unknown>) },
    headers: h.headers,
    cookies: parseCookies(h.headers.cookie),
    address: h.address,
    url: h.url,
    query: { ...h.query },
    secure: h.secure,
    issuedAt: h.issued,
  };
}

export function isClientState(value: unknown): value is ISocketClientState {
  const state = value as ISocketClientState | null | undefined;
  return typeof state?.clientId === 'string' && state.clientId.length > 0 && typeof state.protocol === 'number';
}

export function isAuthState(value: unknown): value is ISocketAuthState {
  const state = value as ISocketAuthState | null | undefined;
  return typeof state?.principal === 'object' && state.principal !== null && typeof state.checkedAt === 'number' && (state.source === null || typeof state.source === 'string');
}

export class SocketConnection<D extends Record<string, unknown> = Record<string, unknown>, U = unknown> {
  public readonly id: string;
  /** The clientId the handshake checked, never re-read from a recovered connection's new `auth`. */
  public readonly clientId: string;
  /** The protocol version the handshake checked. */
  public readonly protocol: number;
  public readonly handshake: ISocketHandshake;
  public readonly connectedAt: number;

  protected readonly lifetime = new AbortController();

  protected closing = false;

  constructor(
    protected readonly socket: Socket,
    handshake: ISocketHandshake,
  ) {
    const client: unknown = socket.data.client;

    // fail closed: a socket the handshake never checked ( eg. recovered from a session stored without this state ) gets no connection
    if (!isClientState(client) || !isAuthState(socket.data.auth)) {
      throw new SocketException('unauthenticated', 'connection state was not set by the handshake');
    }

    this.id = socket.id;
    this.clientId = client.clientId;
    this.protocol = client.protocol;
    this.handshake = handshake;
    this.connectedAt = Date.now();

    if (!socket.data.app) {
      socket.data.app = {};
    }
  }

  /** Principal, its source and the last check. Kept in `socket.data`, which connection state recovery restores. */
  public get auth(): ISocketAuthState {
    return this.socket.data.auth as ISocketAuthState;
  }

  /** The authz-v3 principal; UNATTENDED when no SocketPrincipalSource resolved one. */
  public get principal(): Principal {
    return this.auth.principal;
  }

  /** True when a SocketPrincipalSource resolved the principal. */
  public get authenticated(): boolean {
    return this.auth.source !== null;
  }

  /** The principal's identity record ( `Principal.identity`, eg. the User model ). */
  public get user(): U | undefined {
    return this.principal.identity as U | undefined;
  }

  /** App data bag. Kept in `socket.data`, which connection state recovery restores after a short drop. */
  public get data(): D {
    return this.socket.data.app as D;
  }

  public get rooms(): ReadonlySet<string> {
    const rooms = new Set(this.socket.rooms);
    rooms.delete(this.socket.id);
    return rooms;
  }

  public get connected(): boolean {
    return this.socket.connected;
  }

  /** Aborted when the connection closes. */
  public get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** Pushes an event; a no-op once the principal guard is closing this connection. */
  public emit<P>(name: string, payload: P): void {
    assertPushName(name);

    if (!this.closing) {
      this.send(name, payload);
    }
  }

  /** @internal server notices bypass the name rule and the closing check */
  public notify<P>(name: (typeof SYSTEM_EVENTS)[keyof typeof SYSTEM_EVENTS], payload: P): void {
    this.send(name, payload);
  }

  protected send<P>(name: string, payload: P): void {
    const frame: EventFrame<P> = { name, payload };
    this.socket.emit(WIRE_EVENTS.event, frame);
  }

  /**
   * @internal set by the principal guard; the connection then emits nothing but its own disconnect notice.
   * `revoked` travels with the session socket.io persists on a transport drop, so it is never restored.
   */
  public markClosing(): void {
    this.closing = true;
    this.socket.data.revoked = true;
  }

  public join(room: string | string[]): void {
    void this.socket.join(room);
  }

  public leave(room: string): void {
    void this.socket.leave(room);
  }

  /** Tells the client why, then closes. A server-side disconnect stops socket.io's auto-reconnect. */
  public disconnect(reason: string): void {
    const notice: DisconnectNotice = { reason };
    this.notify(SYSTEM_EVENTS.disconnect, notice);
    this.socket.disconnect(false);
  }

  /** @internal called by the server when the transport closes */
  public close(reason: unknown): void {
    if (!this.lifetime.signal.aborted) {
      this.lifetime.abort(reason);
    }
  }
}
