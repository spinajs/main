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

const userinfo = `planted-user:${SECRET}`;

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

  public get stomp(): Stomp.Client | undefined {
    return this.Client;
  }
}

class QuietConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] } };
  }
}

function probe(host: string | undefined, extra: Partial<IQueueConnectionOptions> = {}): ProbeClient {
  return new ProbeClient({
    name: 'stomp-unopenable',
    service: 'StompQueueClient',
    host,
    login: 'stomp-user',
    password: 'made-up-passcode',
    reconnectDelay: 50,
    connectionTimeout: 1000,
    heartbeatIncoming: 0,
    heartbeatOutgoing: 0,
    ...extra,
  });
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

describe('stomp transport - a broker URL that ws cannot open rejects resolve()', function () {
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

  const unopenable: Array<[what: string, host: string | undefined, shown: string]> = [
    ['does not parse', `ws://${userinfo}@127.0.0.1:99999/stomp?token=${TOKEN}`, '<not a URL>'],
    ['has a scheme ws does not open', `amqp://${userinfo}@127.0.0.1:5672/stomp?token=${TOKEN}`, 'amqp://127.0.0.1:5672/stomp'],
    ['has a fragment', `ws://${userinfo}@127.0.0.1:61614/stomp?token=${TOKEN}#${TOKEN}`, 'ws://127.0.0.1:61614/stomp'],
    ['is a ws+unix URL without a socket path', `ws+unix://${userinfo}@127.0.0.1?token=${TOKEN}`, 'ws+unix://127.0.0.1'],
    ['is empty', '', 'has no host configured'],
    ['is not set', undefined, 'has no host configured'],
  ];

  for (const [what, host, shown] of unopenable) {
    it(`rejects at once when the host ${what}, without quoting it, raising no unhandled rejection and leaving nothing open`, async () => {
      // mocha arms this test's own timeout timer once the test function returns its promise
      await new Promise<void>((resolve) => setImmediate(resolve));
      const handles = trackHandles();
      const client = probe(host);

      const outcome = await settledWithin(client.resolve(), 1000);
      // a stray rejection surfaces after the microtask queue drains, a reconnect after reconnectDelay
      await pause(150);
      await settledWithin(client.dispose(), 1000);
      const open = await handles.open();
      handles.stop();

      expect(outcome.state).to.equal('rejected');
      const error = outcome.state === 'rejected' ? outcome.error : undefined;
      expect(error).to.be.instanceOf(InvalidArgument);
      const text = deepText([error, error instanceof Error ? error.cause : undefined, client.calls]);
      for (const planted of PLANTED) expect(text).to.not.contain(planted);
      expect(messageOf(error)).to.contain('stomp-unopenable').and.to.contain(shown);
      expect(unhandled.map(deepText)).to.deep.equal([]);
      expect(client.stomp?.active ?? false).to.equal(false);
      expect(open).to.deep.equal([]);
    });
  }

  for (const scheme of ['ws', 'wss', 'http', 'https']) {
    it(`still dials a ${scheme}:// host with userinfo and a query`, async () => {
      const port = await closedPort();
      const client = probe(`${scheme}://${userinfo}@127.0.0.1:${port}/stomp?token=${TOKEN}`);
      try {
        const outcome = await settledWithin(client.resolve(), 5000);

        expect(outcome.state).to.equal('rejected');
        expect(messageOf(outcome.state === 'rejected' ? outcome.error : undefined)).to.contain('ECONNREFUSED');
        expect(unhandled).to.deep.equal([]);
      } finally {
        await client.dispose();
      }
    });
  }

  it('refuses exactly the hosts that the installed ws throws for before it dials', async () => {
    class InertClient extends Stomp.Client {
      public override activate(): void {}
    }
    class InertProbe extends ProbeClient {
      protected override createClient(config: Stomp.StompConfig): Stomp.Client {
        return new InertClient(config);
      }
    }
    const hosts = [
      'ws://[::1]:61613/stomp',
      'wss://h.example/x',
      'http://u:p@h.example:8080/a?b=c',
      'https://h.example',
      'WSS://H.EXAMPLE/X',
      'ws://h.example/x#',
      'ws://h.example/x#y',
      'ws://u:pa/ss@h.example/x',
      'ws://h.example:65536/x',
      'ws+unix:sock:/stomp',
      'ws+unix://h',
      'ws+unix://h/',
      'amqp://h',
      'u:p@h.example:61613',
      '127.0.0.1:61613',
    ];
    const disagree: string[] = [];
    for (const host of hosts) {
      let wsThrows = false;
      try {
        // a createConnection that throws keeps ws from dialling; it reports that throw as an event, not by throwing
        new WebSocket(host, Stomp.Versions.default.protocolVersions(), {
          createConnection: () => {
            throw new Error('not dialled');
          },
        }).on('error', () => undefined);
      } catch {
        wsThrows = true;
      }
      const client = new InertProbe({ name: 'stomp-unopenable', service: 'StompQueueClient', host });
      const outcome = await settledWithin(client.resolve(), 50);
      await client.dispose();
      if ((outcome.state === 'rejected') !== wsThrows) disagree.push(`${host}: ws ${wsThrows ? 'throws' : 'dials'}, resolve() ${outcome.state}`);
    }

    expect(disagree).to.deep.equal([]);
  });

  it('leaves the host to options.webSocketFactory when one is set', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    server.on('connection', (socket) => {
      socket.on('message', (data: Buffer) => {
        if (data.toString().startsWith('CONNECT')) socket.send('CONNECTED\nversion:1.2\n\n\0');
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the listener has no port');
    const webSocketFactory = (): WebSocket => new WebSocket(`ws://127.0.0.1:${address.port}/stomp`, Stomp.Versions.default.protocolVersions());
    const client = probe('a host only the factory understands', { options: { webSocketFactory } });
    try {
      const outcome = await settledWithin(client.resolve(), 5000);

      expect(outcome.state).to.equal('resolved');
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.dispose();
    }
  });
});
