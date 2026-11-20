import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { io } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { PROTOCOL_VERSION, SocketHttpHost, SocketPrincipalSource, SocketServer, WIRE_EVENTS } from '@spinajs/http-socket';
import type { CommandReply, ISocketHandshake, SocketError } from '@spinajs/http-socket';
import type { Principal } from '@spinajs/principal';
import { tenantScope } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { SILENT_LOGGER, user } from './source.js';

class TestHttpHost extends SocketHttpHost {
  private readonly http: Server = createServer();

  public server(): Promise<Server> {
    return Promise.resolve(this.http);
  }
}

/** The scope the server's ambient context had in each handshake this source saw. */
export const handshakeScopes: Array<TenantScope | null> = [];

/** `auth.user`: alice (member of acme, attribute `tenant: acme`), carol (member of globex), bob (member of none). */
class TestPrincipalSource extends SocketPrincipalSource {
  public readonly name = 'tenancy-test';
  public readonly order = -100;

  public authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    handshakeScopes.push(tenantScope() ?? null);
    const members = new Map<unknown, Principal>([
      ['alice', user('alice', { tenants: ['acme'], tenant: 'acme' })],
      ['carol', user('carol', { tenants: ['globex'] })],
      ['bob', user('bob')],
    ]);
    return Promise.resolve(members.get(handshake.auth.user) ?? null);
  }
}

const SOCKET_CONFIG = {
  path: '/socket.io',
  cors: { origins: [] },
  auth: { required: false, revalidateMs: 60_000 },
  rate: { perSecond: 1000, burst: 1000 },
  maxPayloadBytes: 65_536,
  maxInFlightPerConnection: 32,
  maxInFlightEventsPerConnection: 1000,
  hooks: { connectTimeoutMs: 10_000 },
  ordering: { abortGraceMs: 1_000 },
  streams: { maxCredits: 8, maxPerConnection: 2, stallTimeoutMs: 10_000 },
  idempotency: { service: 'MemoryIdempotencyStore', ttlMs: 60_000, maxEntries: 1_000 },
  access: { default: 'allow' },
  pingInterval: 25_000,
  pingTimeout: 20_000,
  drainMs: 0,
  shutdownRetryAfterMs: 1_000,
  transports: ['websocket'],
};

export interface SocketApp {
  readonly app: TestApp;
  connect(auth?: Record<string, unknown>, headers?: Record<string, string>): ClientSocket;
  close(): Promise<void>;
}

/**
 * A socket server on the memory registry, with TenantSocketContext loaded by the caller's import. With `ambient`, the
 * server handles every client socket inside that scope, as a server whose own context leaked one would.
 */
export async function startSocketApp(trustProxy: string | undefined, tenancy: Record<string, unknown> = {}, ambient?: TenantScope): Promise<SocketApp> {
  const app = await createTestApp({
    bootstrap: false,
    config: {
      logger: SILENT_LOGGER,
      system: { dirs: { socketControllers: [] } },
      http: { trustProxy, socket: SOCKET_CONFIG },
      tenancy: { registry: 'MemoryTenantRegistry', ...tenancy },
    },
    register: (c) => {
      c.register(TestHttpHost).as(SocketHttpHost);
      c.register(TestPrincipalSource).as(SocketPrincipalSource);
    },
  });
  const server = await app.resolve(SocketServer).catch(async (err: unknown) => {
    await app.dispose();
    throw err;
  });
  const http = await (await app.resolve(SocketHttpHost)).server();
  if (ambient) {
    const als = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<object>;
    // Every event of every client socket, and so the WebSocket frames that carry the handshake, runs in that store.
    http.prependListener('connection', (socket: Socket) => {
      const emit = socket.emit.bind(socket);
      Reflect.set(socket, 'emit', (event: string, ...args: unknown[]) => als.run({ Tenant: ambient }, () => emit(event, ...args)));
    });
  }
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const opened: ClientSocket[] = [];
  let clients = 0;

  return {
    app,
    connect: (auth = {}, headers = {}) => {
      clients += 1;
      const socket = io(url, { path: SOCKET_CONFIG.path, transports: ['websocket'], reconnection: false, forceNew: true, auth: { protocol: PROTOCOL_VERSION, clientId: `tenancy-${clients}`, ...auth }, extraHeaders: headers });
      opened.push(socket);
      return socket;
    },
    close: async () => {
      opened.splice(0).forEach((s) => s.close());
      await server.dispose();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await app.dispose();
    },
  };
}

export function connected(socket: ClientSocket): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

/** The SocketError of a refused handshake, or 'connected'. */
export function handshakeOutcome(socket: ClientSocket): Promise<SocketError | 'connected'> {
  return connected(socket).then(
    () => 'connected',
    (err: { data: SocketError }) => err.data,
  );
}

export async function call<R>(socket: ClientSocket, name: string, payload?: unknown): Promise<R> {
  const reply = (await socket.timeout(5000).emitWithAck(WIRE_EVENTS.command, { id: `${name}-${Math.random()}`, name, payload })) as CommandReply<R>;
  if (!reply.ok || !('result' in reply)) throw new Error(`expected a result reply, got ${JSON.stringify(reply)}`);
  return reply.result;
}
