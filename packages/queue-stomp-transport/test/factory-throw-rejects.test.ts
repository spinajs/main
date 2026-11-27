import 'mocha';
import { expect } from 'chai';
import { createHook } from 'node:async_hooks';
import { createServer } from 'node:net';
import { inspect } from 'node:util';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IQueueConnectionOptions } from '@spinajs/queue';
import Stomp from '@stomp/stompjs';
import WebSocket, { WebSocketServer } from 'ws';

import { StompQueueClient } from '../src/connection.js';

const SECRET = 'planted-secret';
const TOKEN = 'planted-token';
const PLANTED = ['planted-user', SECRET, TOKEN, Buffer.from(`planted-user:${SECRET}`).toString('base64')];
const CONNECTION_TIMEOUT = 1000;
const RECONNECT_DELAY = 50;

const brokerUrl = (port: number): string => `ws://planted-user:${SECRET}@127.0.0.1:${port}/stomp?token=${TOKEN}`;

type Call = [level: string, ...args: unknown[]];

class ProbeClient extends StompQueueClient {
  public readonly calls: Call[] = [];

  public attempts = 0;

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

  public get stomp(): Stomp.Client | undefined {
    return this.Client;
  }

  protected override createWebSocket(): Stomp.IStompSocket {
    this.attempts++;
    return super.createWebSocket();
  }
}

class ThrowingOverride extends ProbeClient {
  protected override createWebSocket(): Stomp.IStompSocket {
    this.attempts++;
    throw new Error(`the override cannot open ${this.Options.host ?? ''}`);
  }
}

class QuietConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] } };
  }
}

function options(host: string, extra: Partial<IQueueConnectionOptions> = {}): IQueueConnectionOptions {
  return {
    name: 'stomp-factory-throw',
    service: 'StompQueueClient',
    host,
    login: 'stomp-user',
    password: 'made-up-passcode',
    reconnectDelay: RECONNECT_DELAY,
    connectionTimeout: CONNECTION_TIMEOUT,
    heartbeatIncoming: 0,
    heartbeatOutgoing: 0,
    ...extra,
  };
}

const deepText = (value: unknown): string => inspect(value, { depth: 6, showHidden: true });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = { state: 'resolved' } | { state: 'rejected'; error: unknown } | { state: 'pending' };

async function settledWithin(promise: Promise<void>, ms: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending' }), ms);
  });
  try {
    return await Promise.race([promise.then((): Outcome => ({ state: 'resolved' }), (error: unknown): Outcome => ({ state: 'rejected', error })), pending]);
  } finally {
    clearTimeout(timer);
  }
}

/** The timers and sockets created while it is enabled and not yet cleared or closed. */
function trackHandles(): { open: () => Promise<string[]>; stop: () => void } {
  const live = new Map<number, string>();
  const hook = createHook({
    init: (id, type) => {
      if (type === 'Timeout' || type.startsWith('TCP')) live.set(id, type);
    },
    destroy: (id) => {
      live.delete(id);
    },
  });
  hook.enable();
  return {
    open: async () => {
      // destroy hooks run on a later turn of the event loop
      for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
      return [...live.values()].sort();
    },
    stop: () => hook.disable(),
  };
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('the listener has no port');
  return address.port;
}

async function stompListener(): Promise<{ port: number; drop: () => void; close: () => Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.on('connection', (socket) => {
    socket.on('message', (data: Buffer) => {
      const frame = data.toString();
      if (frame.startsWith('CONNECT')) socket.send('CONNECTED\nversion:1.2\n\n\0');
      const receipt = /^receipt:(.*)$/m.exec(frame)?.[1];
      if (frame.startsWith('DISCONNECT') && receipt !== undefined) socket.send(`RECEIPT\nreceipt-id:${receipt}\n\n\0`);
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the listener has no port');
  return {
    port: address.port,
    drop: () => {
      for (const socket of server.clients) socket.terminate();
    },
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('stomp transport - a websocket factory that throws rejects resolve()', function () {
  this.timeout(15000);

  let unhandled: unknown[] = [];
  let savedListeners: NodeJS.UnhandledRejectionListener[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(async () => {
    DI.clearCache();
    DI.register(QuietConf).as(Configuration);
    await DI.resolve(Configuration);

    unhandled = [];
    savedListeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', record);
  });

  afterEach(() => {
    process.removeListener('unhandledRejection', record);
    for (const listener of savedListeners) process.on('unhandledRejection', listener);
  });

  const shapes: Array<[what: string, make: (port: number) => ProbeClient, shown: (port: number) => string]> = [
    [
      'an options.webSocketFactory throws',
      (port) => {
        const client: ProbeClient = new ProbeClient(
          options(brokerUrl(port), {
            options: {
              webSocketFactory: (): Stomp.IStompSocket => {
                client.attempts++;
                throw new Error(`the factory cannot dial ${brokerUrl(port)}`);
              },
            },
          }),
        );
        return client;
      },
      (port) => `cannot open a websocket to ws://127.0.0.1:${port}/stomp`,
    ],
    ['a createWebSocket() override throws', (port) => new ThrowingOverride(options(brokerUrl(port))), (port) => `cannot open a websocket to ws://127.0.0.1:${port}/stomp`],
    [
      'options.webSocketFactory is null and the host is not a URL',
      () => new ProbeClient(options(`ws://planted-user:${SECRET}@127.0.0.1:99999/stomp?token=${TOKEN}`, { options: { webSocketFactory: null } })),
      () => 'cannot open a websocket to <not a URL>: its host is not a URL',
    ],
  ];

  for (const [what, make, shown] of shapes) {
    it(`rejects at once when ${what}, without quoting the broker, raising no unhandled rejection and not reconnecting`, async () => {
      // mocha arms this test's own timeout timer once the test function returns its promise
      await new Promise<void>((resolve) => setImmediate(resolve));
      const handles = trackHandles();
      const port = await closedPort();
      const client = make(port);

      const outcome = await settledWithin(client.resolve(), 1000);
      // a stray rejection surfaces after the microtask queue drains, a reconnect after reconnectDelay
      await pause(6 * RECONNECT_DELAY);
      const disposed = await settledWithin(client.dispose(), 1000);
      const leftAfterDispose = await handles.open();
      // stompjs arms its connection watcher before it calls the factory, and its deactivate() does not clear it
      await pause(CONNECTION_TIMEOUT + 100);
      const leftAfterTimeout = await handles.open();
      handles.stop();

      expect(outcome.state).to.equal('rejected');
      const error = outcome.state === 'rejected' ? outcome.error : undefined;
      const text = deepText([error, error instanceof Error ? error.cause : undefined, client.calls]);
      for (const planted of PLANTED) expect(text).to.not.contain(planted);
      expect(error).to.be.instanceOf(InvalidArgument);
      expect(messageOf(error)).to.contain('Queue connection stomp-factory-throw').and.to.contain(shown(port));
      expect(unhandled.map(deepText)).to.deep.equal([]);
      expect(client.attempts).to.be.at.most(1);
      expect(disposed.state).to.equal('resolved');
      expect(client.stomp?.active ?? false).to.equal(false);
      expect(leftAfterDispose.filter((type) => type !== 'Timeout')).to.deep.equal([]);
      expect(leftAfterDispose.length).to.be.at.most(1);
      expect(leftAfterTimeout).to.deep.equal([]);
    });
  }

  it('logs a factory that throws on a reconnect, without quoting the broker, and reconnects again', async () => {
    const listener = await stompListener();
    let attempts = 0;
    const webSocketFactory = (): WebSocket => {
      attempts++;
      if (attempts === 2) throw new Error(`the factory cannot dial ${brokerUrl(listener.port)}`);
      return new WebSocket(`ws://127.0.0.1:${listener.port}/stomp`, Stomp.Versions.default.protocolVersions());
    };
    const client = new ProbeClient(options(brokerUrl(listener.port), { options: { webSocketFactory } }));
    try {
      const outcome = await settledWithin(client.resolve(), 5000);
      expect(outcome.state).to.equal('resolved');

      listener.drop();
      for (let waited = 0; waited < 5000 && !(attempts >= 3 && client.Connected); waited += 25) await pause(25);

      expect(attempts).to.equal(3);
      expect(client.Connected).to.equal(true);
      expect(unhandled.map(deepText)).to.deep.equal([]);
      const failures = client.calls.filter(([level, , template]) => level === 'error' && typeof template === 'string' && template.startsWith('Cannot open a websocket'));
      expect(failures).to.have.length(1);
      expect(deepText(failures)).to.contain(`ws://127.0.0.1:${listener.port}/stomp`).and.to.contain('the factory cannot dial');
      for (const planted of PLANTED) expect(deepText(client.calls)).to.not.contain(planted);
    } finally {
      await settledWithin(client.dispose(), 2000);
      await listener.close();
    }
  });
});
