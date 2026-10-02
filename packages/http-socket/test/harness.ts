import 'mocha';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import { createServer, Server as NodeHttpServer } from 'http';
import { AddressInfo } from 'net';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/authz';
import '@spinajs/log';
import { CommandReply, CommandRequest, EventFrame, PROTOCOL_VERSION, SocketError, WIRE_EVENTS } from '@spinajs/http-socket-common';
import socketConfig from '../src/config/http-socket.js';
import { ISocketHandshake, SocketHttpHost, SocketPrincipalSource } from '../src/interfaces.js';
import { SocketServer } from '../src/server.js';

chai.use(chaiAsPromised);

export const ALICE = { id: 1, name: 'alice' };

export const ALICE_PRINCIPAL: Principal = Object.freeze({ type: 'user', id: '1', authenticated: true, source: 'test', attributes: Object.freeze({}), identity: ALICE });

/** A plain node http server, so socket tests do not need the express stack. */
export class TestHttpHost extends SocketHttpHost {
  public readonly Http: NodeHttpServer = createServer();

  public async server(): Promise<NodeHttpServer> {
    return this.Http;
  }
}

/** Owns only the tokens 'good' and 'bad'; any other handshake is left to the sources of other test files. */
export class TestPrincipalSource extends SocketPrincipalSource {
  public readonly name = 'test';
  public readonly order = 0;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    switch (handshake.auth.token) {
      case 'good':
        return ALICE_PRINCIPAL;
      case 'bad':
        throw new AuthenticationFailed('invalid token');
      default:
        return null;
    }
  }
}

DI.register(TestHttpHost).as(SocketHttpHost);
DI.register(TestPrincipalSource).as(SocketPrincipalSource);

let overrides: Record<string, unknown> = {};

export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return _.merge(
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        configuration: { isProduction: false },
        http: { socket: _.cloneDeep(socketConfig.http.socket) },
      },
      overrides,
    );
  }
}

/** Fresh DI cache and configuration; `cfg` is merged over the test defaults. */
export async function configure(cfg: Record<string, unknown> = {}): Promise<void> {
  overrides = cfg;
  DI.clearCache();
  DI.register(TestConfiguration).as(Configuration);
  await DI.resolve(Configuration);
}

export interface ITestServer {
  server: SocketServer;
  url: string;
  path: string;
  close(): Promise<void>;
}

export async function startServer(cfg: Record<string, unknown> = {}): Promise<ITestServer> {
  await configure(cfg);

  const host = DI.resolve(SocketHttpHost) as TestHttpHost;
  const server = await DI.resolve(SocketServer);
  await new Promise<void>((resolve) => host.Http.listen(0, '127.0.0.1', () => resolve()));
  const { port } = host.Http.address() as AddressInfo;

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    path: DI.get(Configuration)!.get<string>('http.socket.path'),
    close: async () => {
      await server.dispose();
      host.Http.closeAllConnections();
      await new Promise<void>((resolve) => host.Http.close(() => resolve()));
    },
  };
}

export interface IConnectOptions {
  auth?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export function connect(t: ITestServer, options: IConnectOptions = {}): ClientSocket {
  return io(t.url, {
    path: t.path,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { protocol: PROTOCOL_VERSION, clientId: 'client-1', ...options.auth },
    extraHeaders: options.headers,
  });
}

export function connected(socket: ClientSocket): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

export function open(t: ITestServer, options: IConnectOptions = {}): Promise<ClientSocket> {
  return connected(connect(t, options));
}

/** The SocketError of a refused handshake; fails when the handshake is accepted. The caller closes `socket`. */
export function refusalOf(socket: ClientSocket): Promise<SocketError> {
  return connected(socket).then(
    () => {
      throw new Error('the handshake was accepted');
    },
    (err: { data: SocketError }) => err.data,
  );
}

let sequence = 0;

export function nextId(): string {
  sequence += 1;
  return `req-${sequence}`;
}

export function command<R = unknown>(socket: ClientSocket, name: string, payload?: unknown, extra: Partial<CommandRequest> = {}): Promise<CommandReply<R>> {
  const request: CommandRequest = { id: nextId(), name, payload, ...extra };
  return socket.timeout(5000).emitWithAck(WIRE_EVENTS.command, request) as Promise<CommandReply<R>>;
}

export function errorOf(reply: CommandReply): SocketError {
  if (reply.ok) {
    throw new Error(`expected an error reply, got ${JSON.stringify(reply)}`);
  }
  return reply.error;
}

export function resultOf<R>(reply: CommandReply<R>): R {
  if (!reply.ok || !('result' in reply)) {
    throw new Error(`expected a result reply, got ${JSON.stringify(reply)}`);
  }
  return reply.result;
}

export function nextEvent<P = unknown>(socket: ClientSocket, name: string, timeoutMs = 2000): Promise<P> {
  return new Promise((resolve, reject) => {
    const listener = (frame: EventFrame<P>) => {
      if (frame.name !== name) {
        return;
      }
      clearTimeout(timer);
      socket.off(WIRE_EVENTS.event, listener);
      resolve(frame.payload);
    };
    const timer = setTimeout(() => {
      socket.off(WIRE_EVENTS.event, listener);
      reject(new Error(`no ${name} event within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.on(WIRE_EVENTS.event, listener);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) {
      throw new Error('condition not met in time');
    }
    await delay(10);
  }
}
