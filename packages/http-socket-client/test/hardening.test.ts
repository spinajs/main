import 'mocha';
import { expect } from 'chai';
import { CommandDispatcher } from '../src/commands.js';
import { Emitter } from '../src/emitter.js';
import { closeAll } from './support/cleanup.js';
import { makeClient } from './support/client.js';
import { onlineDispatcher, rejectionOf } from './support/commands.js';
import { makeConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until } from './support/wait.js';

describe('Final-review hardening', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    server.handlers.set('ping', () => 'pong');
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  describe('timeout validation', () => {
    const bad = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648];

    for (const value of bad) {
      it(`rejects defaultTimeoutMs ${value}`, () => {
        const connection = makeConnection(server);
        expect(() => new CommandDispatcher(connection, value)).to.throw(RangeError, /defaultTimeoutMs/);
      });

      it(`rejects connectTimeoutMs ${value}`, () => {
        expect(() => makeConnection(server, { connectTimeoutMs: value })).to.throw(RangeError, /connectTimeoutMs/);
      });

      it(`rejects a per-call timeoutMs ${value} with a RangeError`, async () => {
        const { commands } = await onlineDispatcher(server);
        let caught: unknown;
        try {
          await commands.execute('ping', null, { timeoutMs: value });
        } catch (error) {
          caught = error;
        }
        expect(caught).to.be.instanceOf(RangeError);
        expect(server.requests).to.have.length(0);
      });
    }

    it('accepts the largest timer delay', () => {
      const connection = makeConnection(server, { connectTimeoutMs: 2_147_483_647 });
      expect(() => new CommandDispatcher(connection, 2_147_483_647)).to.not.throw();
    });
  });

  describe('command lifecycle', () => {
    it('close() with a command genuinely in flight rejects it with the non-retryable closed error', async () => {
      server.ackFault = { kind: 'drop' };
      const { connection, commands } = await onlineDispatcher(server);
      const pending = rejectionOf(commands.execute('ping', null, { timeoutMs: 5000 }));
      await until(() => server.requests.length === 1);

      connection.close();

      const error = await pending;
      expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client is closed', retryable: false });
    });

    it('releases the abort listener once the command settles', async () => {
      const { commands } = await onlineDispatcher(server);
      const controller = new AbortController();
      const removed: string[] = [];
      const original = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
        removed.push(type);
        return (original as (...args: unknown[]) => void)(type, ...rest);
      }) as typeof controller.signal.removeEventListener;

      await commands.execute('ping', null, { signal: controller.signal });
      controller.abort();
      await sleep(50);

      expect(removed).to.include('abort');
      expect(server.cancels).to.deep.equal([]);
    });

    it('rejects with connection-lost when the connection refuses the request', async () => {
      const { connection, commands } = await onlineDispatcher(server);
      connection.request = () => false;

      const error = await rejectionOf(commands.execute('ping', null));

      expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the connection dropped before the reply', retryable: true });
    });
  });

  describe('autoConnect', () => {
    it("lets a listener attached right after construction see 'connecting'", async () => {
      const client = makeClient(server);
      const seen: string[] = [];
      client.on('state', (state) => seen.push(state));

      await until(() => seen.includes('online'));

      expect(seen.slice(0, 2)).to.deep.equal(['connecting', 'online']);
    });

    it('does not connect a client closed right after construction', async () => {
      const client = makeClient(server);
      client.close();
      await sleep(50);

      expect(client.state).to.equal('closed');
      expect(server.handshakes).to.have.length(0);
    });
  });

  describe('Emitter', () => {
    it('does not let a throwing onListenerError escape emit()', () => {
      const emitter = new Emitter<{ tick: () => void }>(() => {
        throw new Error('handler failed too');
      });
      const calls: string[] = [];
      emitter.on('tick', () => {
        throw new Error('listener failed');
      });
      emitter.on('tick', () => calls.push('second'));

      expect(() => emitter.emit('tick')).to.not.throw();
      expect(calls).to.deep.equal(['second']);
    });
  });
});

