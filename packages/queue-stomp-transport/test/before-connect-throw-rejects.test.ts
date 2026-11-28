import 'mocha';
import { expect } from 'chai';
import { createServer } from 'node:net';
import { inspect } from 'node:util';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IQueueConnectionOptions } from '@spinajs/queue';
import Stomp from '@stomp/stompjs';
import { WebSocketServer } from 'ws';

import { StompQueueClient } from '../src/connection.js';

const USER = 'hook-made-up-user';
const SECRET = 'hook-made-up-secret';
const TOKEN = 'hook-made-up-token';
const PLANTED = [USER, SECRET, TOKEN, Buffer.from(`${USER}:${SECRET}`).toString('base64')];
// a planted value cut short or split by masking still leaks when 8 of its characters survive in a row
const PLANTED_RUNS = [...new Set(PLANTED.flatMap((value) => Array.from({ length: value.length - 7 }, (_, at) => value.slice(at, at + 8))))];
const RECONNECT_DELAY = 50;

const brokerUrl = (port: number): string => `ws://${USER}:${SECRET}@127.0.0.1:${port}/stomp?token=${TOKEN}`;
const hookError = (port: number): Error => new Error(`cannot fetch a token for ${brokerUrl(port)} with secret ${SECRET}`);

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

class QuietConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] } };
  }
}

function options(host: string, beforeConnect: unknown): IQueueConnectionOptions {
  return {
    name: 'stomp-before-connect',
    service: 'StompQueueClient',
    host,
    login: 'stomp-user',
    password: 'made-up-passcode',
    reconnectDelay: RECONNECT_DELAY,
    connectionTimeout: 1000,
    heartbeatIncoming: 0,
    heartbeatOutgoing: 0,
    options: { beforeConnect },
  };
}

const fullText = (value: unknown): string => inspect(value, { depth: null, showHidden: true });
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function captureStderr(): { text: () => string; stop: () => void } {
  const write = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  return {
    text: () => chunks.join(''),
    stop: () => {
      process.stderr.write = write;
    },
  };
}

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

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('the listener has no port');
  if (address.address !== '127.0.0.1') throw new Error(`the listener is bound to ${address.address}, not 127.0.0.1`);
  return address.port;
}

async function stompListener(): Promise<{ port: number; address: string; connectFrames: string[]; connections: () => number; drop: () => void; close: () => Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const connectFrames: string[] = [];
  let connections = 0;
  server.on('connection', (socket) => {
    connections++;
    socket.on('message', (data: Buffer) => {
      const frame = data.toString();
      if (frame.startsWith('CONNECT')) {
        connectFrames.push(frame);
        socket.send('CONNECTED\nversion:1.2\n\n\0');
      }
      const receipt = /^receipt:(.*)$/m.exec(frame)?.[1];
      if (frame.startsWith('DISCONNECT') && receipt !== undefined) socket.send(`RECEIPT\nreceipt-id:${receipt}\n\n\0`);
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the listener has no port');
  return {
    port: address.port,
    address: address.address,
    connectFrames,
    connections: () => connections,
    drop: () => {
      for (const socket of server.clients) socket.terminate();
    },
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('stomp transport - an options.beforeConnect that throws rejects resolve()', function () {
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

  const printed = 'Error: cannot fetch a token for ws://127.0.0.1:';
  const unprintable = 'a thrown value that cannot be printed';
  const failing: Array<[what: string, hook: (port: number) => () => void | Promise<void>, reason: string]> = [
    [
      'throws',
      (port) => () => {
        throw hookError(port);
      },
      printed,
    ],
    ['returns a rejected promise', (port) => () => Promise.reject(hookError(port)), printed],
    [
      'throws a value with no string form',
      () => () => {
        throw Object.create(null);
      },
      unprintable,
    ],
    [
      'throws a value whose toString throws an error quoting the broker url',
      (port) => () => {
        // what an application can throw: any value, not only an Error
        const thrown: unknown = {
          toString: () => {
            throw hookError(port);
          },
        };
        throw thrown;
      },
      unprintable,
    ],
  ];

  for (const [what, hook, reason] of failing) {
    it(`rejects at once when options.beforeConnect ${what}, redacted, deactivated and raising no unhandled rejection`, async () => {
      const port = await closedPort();
      const stderr = captureStderr();
      let hookCalls = 0;
      const failure = hook(port);
      const client = new ProbeClient(
        options(brokerUrl(port), () => {
          hookCalls++;
          return failure();
        }),
      );

      const outcome = await settledWithin(client.resolve(), 1000);
      // a stray rejection surfaces after the microtask queue drains, a reconnect after reconnectDelay
      await pause(6 * RECONNECT_DELAY);
      const disposed = await settledWithin(client.dispose(), 1000);
      stderr.stop();

      const error = outcome.state === 'rejected' ? outcome.error : undefined;
      const everything = [fullText(error), error instanceof Error ? (error.stack ?? '') : '', fullText(error instanceof Error ? error.cause : undefined), fullText(client.calls), fullText(unhandled), stderr.text()].join('\n');
      // one assertion, so a failure shows all three at once
      expect({ state: outcome.state, unhandled: unhandled.length, planted: PLANTED_RUNS.filter((run) => everything.includes(run)) }).to.deep.equal({ state: 'rejected', unhandled: 0, planted: [] });
      expect(error).to.be.instanceOf(InvalidArgument);
      expect(error instanceof Error ? error.message : '').to.contain(`Queue connection stomp-before-connect: options.beforeConnect failed: ${reason}`);
      expect(error instanceof Error ? error.cause : 'no error').to.equal(undefined);
      expect(unhandled).to.have.length(0);
      expect(hookCalls).to.equal(1);
      expect(client.attempts).to.equal(0);
      expect(client.stomp?.active).to.equal(false);
      expect(disposed.state).to.equal('resolved');
    });
  }

  it('logs a throw on a reconnect redacted at error, and connects anyway', async () => {
    const listener = await stompListener();
    let hookCalls = 0;
    const client = new ProbeClient(
      options(brokerUrl(listener.port), () => {
        hookCalls++;
        if (hookCalls === 2) throw hookError(listener.port);
      }),
    );
    try {
      expect(listener.address).to.equal('127.0.0.1');
      expect((await settledWithin(client.resolve(), 5000)).state).to.equal('resolved');

      listener.drop();
      for (let waited = 0; waited < 5000 && !(hookCalls >= 2 && client.Connected && listener.connectFrames.length >= 2); waited += 25) await pause(25);

      expect(hookCalls).to.equal(2);
      expect(listener.connectFrames).to.have.length(2);
      expect(client.Connected).to.equal(true);
      expect(unhandled).to.have.length(0);
      const failures = client.calls.filter(([level, , template]) => level === 'error' && typeof template === 'string' && template.startsWith('options.beforeConnect failed'));
      expect(failures).to.have.length(1);
      expect(fullText(failures)).to.contain('cannot fetch a token for ws://127.0.0.1:');
      expect(PLANTED_RUNS.filter((run) => fullText(client.calls).includes(run))).to.deep.equal([]);
    } finally {
      await settledWithin(client.dispose(), 2000);
      await listener.close();
    }
  });

  for (const late of ['resolves', 'rejects'] as const) {
    it(`opens no socket when options.beforeConnect ${late} after dispose()`, async () => {
      const listener = await stompListener();
      let settle: () => void = () => undefined;
      const client = new ProbeClient(
        options(
          brokerUrl(listener.port),
          () =>
            new Promise<void>((resolve, reject) => {
              settle = late === 'resolves' ? resolve : () => reject(hookError(listener.port));
            }),
        ),
      );
      try {
        const outcome = settledWithin(client.resolve(), 1000);
        await pause(RECONNECT_DELAY);
        expect((await settledWithin(client.dispose(), 1000)).state).to.equal('resolved');
        settle();
        await pause(6 * RECONNECT_DELAY);

        // dispose() before the first connect leaves resolve() pending on its own (a separate defect); here it must not connect
        const settled = await outcome;
        expect(settled.state).to.not.equal('resolved');
        expect(client.attempts).to.equal(0);
        expect(listener.connections()).to.equal(0);
        expect(unhandled).to.have.length(0);
        const everything = fullText([settled, client.calls]);
        expect(PLANTED_RUNS.filter((run) => everything.includes(run))).to.deep.equal([]);
      } finally {
        await listener.close();
      }
    });
  }

  it('awaits an async options.beforeConnect that resolves, calling it with the stompjs client as this and no argument, and sends the headers it sets', async () => {
    const listener = await stompListener();
    const seen: Array<{ self: unknown; args: number }> = [];
    const client = new ProbeClient(
      options(brokerUrl(listener.port), async function (this: Stomp.Client, ...args: unknown[]): Promise<void> {
        seen.push({ self: this, args: args.length });
        await pause(RECONNECT_DELAY);
        this.connectHeaders = { ...this.connectHeaders, 'x-from-hook': 'set-after-await' };
      }),
    );
    try {
      expect((await settledWithin(client.resolve(), 5000)).state).to.equal('resolved');

      expect(seen).to.have.length(1);
      expect(seen[0].self).to.equal(client.stomp);
      expect(seen[0].args).to.equal(0);
      expect(listener.connectFrames).to.have.length(1);
      expect(listener.connectFrames[0]).to.contain('x-from-hook:set-after-await');
    } finally {
      await settledWithin(client.dispose(), 2000);
      await listener.close();
    }
  });

  it('connects when options.beforeConnect is not a function, as when it is unset', async () => {
    const listener = await stompListener();
    const client = new ProbeClient(options(brokerUrl(listener.port), null));
    try {
      expect((await settledWithin(client.resolve(), 5000)).state).to.equal('resolved');
      expect(unhandled).to.have.length(0);
    } finally {
      await settledWithin(client.dispose(), 2000);
      await listener.close();
    }
  });
});
