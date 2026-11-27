import 'mocha';
import { expect } from 'chai';
import { createServer, Server, Socket } from 'node:net';
import { inspect } from 'node:util';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { IQueueConnectionOptions } from '@spinajs/queue';
import type Stomp from '@stomp/stompjs';
import { WebSocketServer } from 'ws';

import { StompQueueClient } from '../src/connection.js';

const SECRET = 'planted-secret';
const TOKEN = 'planted-token';
const PASSCODE = 'planted-passcode';
// `ws` sends URL userinfo as an `Authorization: Basic` header of the upgrade request.
const BASIC = Buffer.from(`planted-user:${SECRET}`).toString('base64');
const PLANTED = ['planted-user', SECRET, TOKEN, PASSCODE, BASIC];

const brokerUrl = (port: number | string): string => `ws://planted-user:${SECRET}@127.0.0.1:${port}/stomp?token=${TOKEN}`;

type Call = [level: string, ...args: unknown[]];

class ProbeClient extends StompQueueClient {
  public readonly calls: Call[] = [];

  constructor(options: IQueueConnectionOptions) {
    super(options);
    const at =
      (level: string) =>
      (...args: unknown[]): void => {
        this.calls.push([level, ...args]);
      };
    // @Logger injection does not run for a direct `new`.
    Object.defineProperty(this, 'Log', {
      configurable: true,
      value: { trace: at('trace'), debug: at('debug'), info: at('info'), success: at('success'), warn: at('warn'), error: at('error'), fatal: at('fatal'), security: at('security') },
    });
  }

  public get stomp(): Stomp.Client {
    return this.Client;
  }

  public openSocket(): unknown {
    return this.createWebSocket();
  }
}

class QuietConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] } };
  }
}

function probe(host: string, extra: Partial<IQueueConnectionOptions> = {}): ProbeClient {
  return new ProbeClient({
    name: 'stomp-redacted',
    service: 'StompQueueClient',
    host,
    login: 'stomp-user',
    password: PASSCODE,
    reconnectDelay: 50,
    connectionTimeout: 1000,
    heartbeatIncoming: 0,
    heartbeatOutgoing: 0,
    ...extra,
  });
}

const deepText = (value: unknown): string => inspect(value, { depth: 6, showHidden: true });

function expectNonePlanted(text: string): void {
  for (const planted of PLANTED) expect(text).to.not.contain(planted);
}

function portOf(server: Server | WebSocketServer): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the listener has no port');
  return address.port;
}

async function tcpListener(onSocket: (socket: Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: portOf(server),
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function closedPort(): Promise<number> {
  const listener = await tcpListener(() => undefined);
  await listener.close();
  return listener.port;
}

/** A broker of a few lines: answers every CONNECT frame with `reply`. */
async function stompListener(reply: string): Promise<{ port: number; close: (reason?: string) => Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.on('connection', (socket) => {
    socket.on('message', (data: Buffer) => {
      if (data.toString().startsWith('CONNECT')) socket.send(`${reply}\0`);
    });
  });
  return {
    port: portOf(server),
    close: (reason) => {
      for (const socket of server.clients) {
        if (reason === undefined) socket.terminate();
        else socket.close(4000, reason);
      }
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function failedConnect(client: ProbeClient): Promise<unknown> {
  try {
    await client.resolve();
  } catch (err) {
    return err;
  }
  throw new Error('resolve() was expected to fail');
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const linesAt = (client: ProbeClient, level: string): string => deepText(client.calls.filter(([at]) => at === level));

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

describe('stomp transport - broker URL and passcode stay out of logs and errors', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(QuietConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  it('logs and reconnects without the URL credentials or the passcode', async () => {
    const broker = await stompListener('CONNECTED\nversion:1.2\n\n');
    const client = probe(brokerUrl(broker.port));
    try {
      await client.resolve();
      // the broker goes away with a close reason that repeats the query: every reconnect is refused
      await broker.close(`going away from /stomp?token=${TOKEN}`);
      await until(() => client.calls.filter(([level, vars]) => level === 'error' && deepText(vars).includes('ECONNREFUSED')).length >= 2);

      const text = deepText(client.calls);
      expectNonePlanted(text);
      expect(linesAt(client, 'info')).to.contain(`ws://127.0.0.1:${broker.port}/stomp`);
      expect(linesAt(client, 'trace')).to.contain('passcode:');
      expect(linesAt(client, 'trace')).to.contain(`Connection closed to ws://127.0.0.1:${broker.port}/stomp`);
      expect(linesAt(client, 'error')).to.contain(`127.0.0.1:${broker.port}`);
      expect(linesAt(client, 'warn')).to.contain('4000').and.to.contain('going away from /stomp?');
    } finally {
      await client.dispose();
    }
  });

  it('redacts a websocket error that repeats the broker URL, whole or cut short', async () => {
    const listener = await tcpListener(() => undefined);
    const host = brokerUrl(listener.port);
    try {
      for (const echo of [host, host.slice(0, 30)]) {
        const client = probe(host);
        const connecting = failedConnect(client);
        const error = Object.assign(new Error(`Invalid URL: ${echo}`), { code: 'ERR_PLANTED' });
        client.stomp.onWebSocketError({ type: 'error', message: error.message, error });

        const rejection = await connecting;
        await client.dispose();
        expectNonePlanted(deepText([rejection, client.calls]));
        expect(messageOf(rejection)).to.contain('Invalid URL: ').and.to.contain('ERR_PLANTED');
      }
    } finally {
      await listener.close();
    }
  });

  it('rejects a refused connection without the URL credentials', async () => {
    const port = await closedPort();
    const client = probe(brokerUrl(port));
    try {
      const error = await failedConnect(client);

      expectNonePlanted(deepText([error, client.calls]));
      expect(messageOf(error)).to.contain(`ws://127.0.0.1:${port}/stomp`).and.to.contain('ECONNREFUSED');
    } finally {
      await client.dispose();
    }
  });

  it('rejects a connection the listener drops at once without the URL credentials', async () => {
    const listener = await tcpListener((socket) => socket.destroy());
    const client = probe(brokerUrl(listener.port));
    try {
      const error = await failedConnect(client);

      expectNonePlanted(deepText([error, client.calls]));
      expect(messageOf(error)).to.contain(`ws://127.0.0.1:${listener.port}/stomp`).and.to.contain('ECONNRESET');
    } finally {
      await client.dispose();
      await listener.close();
    }
  });

  it('rejects a listener that never answers as a connection timeout, without the URL credentials', async () => {
    const listener = await tcpListener(() => undefined);
    const client = probe(brokerUrl(listener.port), { connectionTimeout: 200 });
    try {
      const error = await failedConnect(client);

      expectNonePlanted(deepText([error, client.calls]));
      expect(messageOf(error)).to.contain(`ws://127.0.0.1:${listener.port}/stomp`).and.to.contain('connection timeout');
    } finally {
      await client.dispose();
      await listener.close();
    }
  });

  it('rejects an ERROR frame as the broker reported it, without the URL credentials or the passcode', async () => {
    const broker = await stompListener('ERROR\nmessage:Authentication failed\ncontent-type:text/plain\n\nUser name [stomp-user] or password is invalid.');
    const client = probe(brokerUrl(broker.port));
    try {
      const error = await failedConnect(client);

      expectNonePlanted(deepText([error, client.calls]));
      expect(messageOf(error)).to.contain(`ws://127.0.0.1:${broker.port}/stomp`).and.to.contain('Authentication failed');
      expect(linesAt(client, 'error')).to.contain('Authentication failed');
    } finally {
      await client.dispose();
      await broker.close();
    }
  });

  it('throws for a URL that does not parse without quoting it', () => {
    const client = probe(brokerUrl(99999));

    let thrown: unknown;
    try {
      client.openSocket();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).to.be.instanceOf(Error);
    expectNonePlanted(deepText(thrown));
    expect(messageOf(thrown)).to.contain('<not a URL>');
  });
});
