import 'mocha';
import { expect } from 'chai';
import { createHook } from 'node:async_hooks';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { IQueueConnectionOptions } from '@spinajs/queue';
import Stomp from '@stomp/stompjs';
import WebSocket, { WebSocketServer } from 'ws';

import { StompQueueClient } from '../src/connection.js';

const RECONNECT_DELAY = 50;
const NAME = 'stomp-dispose';
const DISPOSED = `Queue connection ${NAME} was disposed before it connected`;

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

  public errorsStartingWith(prefix: string): Call[] {
    return this.calls.filter(([level, , template]) => level === 'error' && typeof template === 'string' && template.startsWith(prefix));
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

function options(port: number, transport: Record<string, unknown> = {}): IQueueConnectionOptions {
  return {
    name: NAME,
    service: 'StompQueueClient',
    host: `ws://127.0.0.1:${port}/stomp`,
    login: 'made-up-user',
    password: 'made-up-passcode',
    reconnectDelay: RECONNECT_DELAY,
    connectionTimeout: 1000,
    heartbeatIncoming: 0,
    heartbeatOutgoing: 0,
    options: transport,
  };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Timers created after the call and neither fired nor cleared yet. */
function trackTimers(): { open: () => number; stop: () => void } {
  const ids = new Set<number>();
  const hook = createHook({
    init: (id, type) => {
      if (type === 'Timeout') ids.add(id);
    },
    destroy: (id) => {
      ids.delete(id);
    },
  }).enable();
  return {
    open: () => ids.size,
    stop: () => {
      hook.disable();
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

const messageOf = (outcome: Outcome): string => (outcome.state === 'rejected' && outcome.error instanceof Error ? outcome.error.message : `not rejected: ${outcome.state}`);

/** A STOMP listener on 127.0.0.1; `refuseFirst` closes the first upgrade with 1000 before CONNECTED. */
async function stompListener(refuseFirst = false): Promise<{ port: number; address: string; connectFrames: string[]; connections: () => number; drop: () => void; close: () => Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const connectFrames: string[] = [];
  let connections = 0;
  server.on('connection', (socket) => {
    connections++;
    if (refuseFirst && connections === 1) {
      socket.close(1000);
      return;
    }
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

async function until(done: () => boolean, ms = 5000): Promise<void> {
  for (let waited = 0; waited < ms && !done(); waited += 25) await pause(25);
}

describe('stomp transport - dispose() settles resolve()', function () {
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

  it('rejects resolve() when dispose() runs in the same turn, before the first connect, and leaves nothing open', async () => {
    const listener = await stompListener();
    try {
      expect(listener.address).to.equal('127.0.0.1');
      const client = new ProbeClient(options(listener.port));

      const tracked = trackTimers();
      const resolving = client.resolve();
      const disposing = client.dispose();
      const outcome = await settledWithin(resolving, 1000);
      const disposed = await settledWithin(disposing, 1000);
      await pause(6 * RECONNECT_DELAY);
      // a timer's destroy is reported after its callback ran
      await new Promise((resolve) => setImmediate(resolve));
      const leftOpen = tracked.open();
      tracked.stop();

      // one assertion, so a failure shows every part at once
      expect({ state: outcome.state, message: messageOf(outcome), unhandled: unhandled.length }).to.deep.equal({ state: 'rejected', message: DISPOSED, unhandled: 0 });
      expect(outcome.state === 'rejected' ? outcome.error : undefined).to.be.instanceOf(UnexpectedServerError);
      expect(disposed.state).to.equal('resolved');
      expect(client.attempts).to.equal(0);
      expect(listener.connections()).to.equal(0);
      expect(client.stomp?.active).to.equal(false);
      expect(leftOpen).to.equal(0);
    } finally {
      await listener.close();
    }
  });

  it('does not log "connecting anyway" when dispose() lands while a reconnect-time options.beforeConnect is pending and the hook then throws', async () => {
    const listener = await stompListener();
    let hookCalls = 0;
    let fail: () => void = () => undefined;
    const client = new ProbeClient(
      options(listener.port, {
        beforeConnect: () => {
          hookCalls++;
          if (hookCalls === 1) return undefined;
          return new Promise<void>((_resolve, reject) => {
            fail = () => reject(new Error('the token service is down'));
          });
        },
      }),
    );
    try {
      expect(listener.address).to.equal('127.0.0.1');
      expect((await settledWithin(client.resolve(), 5000)).state).to.equal('resolved');

      listener.drop();
      await until(() => hookCalls >= 2);
      expect(hookCalls).to.equal(2);
      expect((await settledWithin(client.dispose(), 1000)).state).to.equal('resolved');
      fail();
      await pause(6 * RECONNECT_DELAY);

      expect({ logged: client.errorsStartingWith('options.beforeConnect failed').length, unhandled: unhandled.length }).to.deep.equal({ logged: 0, unhandled: 0 });
      expect(listener.connectFrames).to.have.length(1);
    } finally {
      await settledWithin(client.dispose(), 1000);
      await listener.close();
    }
  });

  it('does not log a websocket failure when the application factory disposes the client and then throws on a reconnect', async () => {
    const listener = await stompListener();
    let factoryCalls = 0;
    const client: ProbeClient = new ProbeClient(
      options(listener.port, {
        webSocketFactory: () => {
          factoryCalls++;
          if (factoryCalls === 1) return new WebSocket(`ws://127.0.0.1:${listener.port}/stomp`, Stomp.Versions.default.protocolVersions());
          void client.dispose();
          throw new Error('the socket pool is closed');
        },
      }),
    );
    try {
      expect(listener.address).to.equal('127.0.0.1');
      expect((await settledWithin(client.resolve(), 5000)).state).to.equal('resolved');

      listener.drop();
      await until(() => factoryCalls >= 2);
      await pause(6 * RECONNECT_DELAY);

      expect(factoryCalls).to.equal(2);
      expect({ logged: client.errorsStartingWith('Cannot open a websocket').length, unhandled: unhandled.length }).to.deep.equal({ logged: 0, unhandled: 0 });
      expect(client.stomp?.active).to.equal(false);
    } finally {
      await settledWithin(client.dispose(), 1000);
      await listener.close();
    }
  });

  it('resolves as before when the first socket closes without dispose() and stompjs reconnects', async () => {
    const listener = await stompListener(true);
    const client = new ProbeClient(options(listener.port));
    try {
      expect(listener.address).to.equal('127.0.0.1');
      const outcome = await settledWithin(client.resolve(), 5000);

      expect(outcome.state).to.equal('resolved');
      expect(listener.connections()).to.equal(2);
      expect(unhandled).to.have.length(0);
    } finally {
      await settledWithin(client.dispose(), 1000);
      await listener.close();
    }
  });

  it('a dispose() after the first connect leaves resolve() resolved and logs no failure', async () => {
    const listener = await stompListener();
    const client = new ProbeClient(options(listener.port));
    try {
      expect(listener.address).to.equal('127.0.0.1');
      const resolving = client.resolve();
      expect((await settledWithin(resolving, 5000)).state).to.equal('resolved');
      expect((await settledWithin(client.dispose(), 1000)).state).to.equal('resolved');
      await pause(2 * RECONNECT_DELAY);

      expect((await settledWithin(resolving, 100)).state).to.equal('resolved');
      expect(client.calls.filter(([level]) => level === 'error')).to.deep.equal([]);
      expect(unhandled).to.have.length(0);
    } finally {
      await listener.close();
    }
  });
});
