import { io } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { PROTOCOL_VERSION, SYSTEM_EVENTS, SocketDispatcher, SocketHandlerRegistry, SocketHub, SocketPrincipalGuard, SocketServer, WIRE_EVENTS } from '@spinajs/http-socket';
import type { CommandReply, CommandRequest, EventFrame, SocketError } from '@spinajs/http-socket';

import { APP_ORIGIN, config, cookieName } from '../v3-app/app.js';

/** Attaches a SocketServer to the running v3 app's http server ( HttpServerHost ); `revalidateMs` short enough to wait out. */
export async function startSockets(revalidateMs: number): Promise<void> {
  const cfg = config();
  if (cfg.get('http.socket.path') === undefined) {
    throw new Error('http.socket is not configured: build packages/http-socket, whose lib/mjs/config holds its defaults');
  }
  cfg.set(['http', 'socket', 'auth', 'revalidateMs'], revalidateMs);
  await DI.resolve(SocketServer);
}

/** Closes the socket server and forgets its singletons, so the next suite starts one on a fresh app. */
export async function stopSockets(): Promise<void> {
  await DI.get(SocketServer)?.dispose();
  for (const type of [SocketServer, SocketHub, SocketDispatcher, SocketPrincipalGuard, SocketHandlerRegistry] as Class<unknown>[]) {
    DI.uncache(type);
  }
}

export interface SocketOptions {
  /** the signed session cookie value, as `Client.cookie` holds it */
  cookie?: string | null;
  /** sent as `auth.token`, as a browser client sends a bearer token */
  token?: string;
  origin?: string;
}

const opened: ClientSocket[] = [];
let clients = 0;
let ids = 0;

export function socketTo(o: SocketOptions = {}): ClientSocket {
  const headers: Record<string, string> = {};
  if (o.cookie) headers.cookie = `${cookieName()}=${encodeURIComponent(o.cookie)}`;
  if (o.origin) headers.origin = o.origin;

  const socket = io(APP_ORIGIN, {
    path: config().get<string>('http.socket.path'),
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { protocol: PROTOCOL_VERSION, clientId: `v3-socket-${++clients}`, ...(o.token ? { token: o.token } : {}) },
    extraHeaders: headers,
  });
  opened.push(socket);
  return socket;
}

export function closeSockets(): void {
  opened.splice(0).forEach((s) => s.close());
}

export function connected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
}

/** The SocketError of a refused handshake; fails when the handshake is accepted. */
export function refusalOf(socket: ClientSocket): Promise<SocketError> {
  return connected(socket).then(
    () => {
      throw new Error('the handshake was accepted');
    },
    (err: { data: SocketError }) => err.data,
  );
}

export function command<R = unknown>(socket: ClientSocket, name: string, payload: unknown = null): Promise<CommandReply<R>> {
  const request: CommandRequest = { id: `v3-socket-cmd-${++ids}`, name, payload };
  return socket.timeout(5000).emitWithAck(WIRE_EVENTS.command, request) as Promise<CommandReply<R>>;
}

export function resultOf<R>(reply: CommandReply<R>): R {
  if (!reply.ok || !('result' in reply)) {
    throw new Error(`expected a result reply, got ${JSON.stringify(reply)}`);
  }
  return reply.result;
}

export function errorOf(reply: CommandReply): SocketError {
  if (reply.ok) {
    throw new Error(`expected an error reply, got ${JSON.stringify(reply)}`);
  }
  return reply.error;
}

/** The payload of the `sys.disconnect` notice the server sends before it closes the socket. */
export function disconnectNotice(socket: ClientSocket, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${SYSTEM_EVENTS.disconnect} within ${timeoutMs} ms`)), timeoutMs);
    socket.on(WIRE_EVENTS.event, (frame: EventFrame) => {
      if (frame.name === SYSTEM_EVENTS.disconnect) {
        clearTimeout(timer);
        resolve(frame.payload);
      }
    });
  });
}
