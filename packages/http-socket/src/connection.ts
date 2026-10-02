import { Socket } from 'socket.io';
import { UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DisconnectNotice, EventFrame, SYSTEM_EVENTS, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { ISocketAuthState, ISocketHandshake } from './interfaces.js';

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

export class SocketConnection<D extends Record<string, unknown> = Record<string, unknown>, U = unknown> {
  public readonly id: string;
  public readonly clientId: string;
  public readonly handshake: ISocketHandshake;
  public readonly connectedAt: number;

  protected readonly lifetime = new AbortController();

  constructor(
    protected readonly socket: Socket,
    handshake: ISocketHandshake,
  ) {
    this.id = socket.id;
    this.clientId = String(handshake.auth.clientId);
    this.handshake = handshake;
    this.connectedAt = Date.now();

    if (!socket.data.auth) {
      const unattended: ISocketAuthState = { principal: UNATTENDED, source: null, checkedAt: this.connectedAt };
      socket.data.auth = unattended;
    }

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

  public emit<P>(name: string, payload: P): void {
    const frame: EventFrame<P> = { name, payload };
    this.socket.emit(WIRE_EVENTS.event, frame);
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
    this.emit(SYSTEM_EVENTS.disconnect, notice);
    this.socket.disconnect(false);
  }

  /** @internal called by the server when the transport closes */
  public close(reason: unknown): void {
    if (!this.lifetime.signal.aborted) {
      this.lifetime.abort(reason);
    }
  }
}
