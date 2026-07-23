import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import http from 'http';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { HttpServer } from '../src/server.js';
import { LifecycleState } from '../src/interfaces.js';
import { TestConfiguration } from './common.js';

/**
 * Fire one request through a keep-alive agent and wait for the full response,
 * leaving the underlying socket parked in the agent's idle pool. Best-effort:
 * even a 404 leaves an idle keep-alive socket, which is all this needs.
 */
function idleKeepAliveRequest(agent: http.Agent, port: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      res.on('data', () => {
        /* drain */
      });
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
  });
}

/**
 * `ShutdownTimeout` is a `@Config` getter ( non-writable ), so tests shadow it
 * with an own instance data property to drive a deterministic grace window.
 */
function setShutdownTimeout(s: HttpServer, ms: number): void {
  Object.defineProperty(s, 'ShutdownTimeout', { value: ms, configurable: true, writable: true });
}
function restoreShutdownTimeout(s: HttpServer): void {
  delete (s as any).ShutdownTimeout;
}

describe('HttpServer lifecycle', () => {
  let server: HttpServer;

  beforeEach(async () => {
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    server = await DI.resolve<HttpServer>(HttpServer);
  });

  afterEach(async () => {
    // always land in a closed state so the next test can re-listen the singleton
    try {
      await server.stop();
    } catch {
      /* stop must not throw; swallow just in case so teardown never masks a test */
    }
  });

  describe('shutdown (bugs 1, 2, 3)', () => {
    it('stop() then dispose() both resolve without rejecting (bug 2)', async () => {
      await server.start();
      await server.stop();
      // second close via dispose must be a no-op, not ERR_SERVER_NOT_RUNNING
      await server.dispose();
      expect(server.State).to.eq(LifecycleState.Closed);
    });

    it('stop() returns an awaitable promise whose resolution frees the port for a re-listen (bug 3)', async () => {
      await server.start();
      const port = (server as any).HttpConfig.port as number;
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

      // A generous grace makes any accidental watchdog hang obvious rather than
      // silently absorbed. NOTE ( Node 24 ): Server.close() already reaps idle
      // keep-alive sockets on its own - it even calls closeIdleConnections()
      // internally - so neither a timing test nor a spy can distinguish our
      // explicit closeIdleConnections() call here. The one thing that genuinely
      // regresses if bug 3 returns is stop() reverting to `void`, so that is
      // what this test pins ( plus the port actually re-binding afterwards ).
      setShutdownTimeout(server, 3000);
      try {
        // park one idle keep-alive socket so the shutdown path has real work
        await idleKeepAliveRequest(agent, port);

        const t = process.hrtime.bigint();
        const p = server.stop();
        // bug 3 was that stop() returned void; awaiting a void is a no-op and the
        // caller could never know when the port was free. It must be a thenable.
        expect(p, 'stop() must return a value, not void').to.exist;
        expect(typeof (p as Promise<void>).then).to.eq('function');
        await p;
        const ms = Number(process.hrtime.bigint() - t) / 1e6;

        // resolution must mean genuinely closed, promptly ( no watchdog hang )
        expect(server.State).to.eq(LifecycleState.Closed);
        expect(ms).to.be.lessThan(1000);
      } finally {
        agent.destroy();
        restoreShutdownTimeout(server);
      }

      // the awaited stop() must have released the port: a second listen on the
      // same port would EADDRINUSE if it had not
      await server.start();
      expect(server.State).to.eq(LifecycleState.Listening);
    });

    it('a clean close clears the watchdog so nothing is force-closed after the grace window (bug 1)', async () => {
      await server.start();

      // Tiny grace window: a leaked / uncleared watchdog would fire almost at
      // once and log the force-close warning; a cleared one never fires.
      setShutdownTimeout(server, 50);
      const warn = sinon.spy((server as any).Log, 'warn');
      try {
        await server.dispose();
        // wait well past the 50ms window before judging
        await new Promise((r) => setTimeout(r, 150));

        const graceExpired = warn.getCalls().some((c) => String(c.args[0]).includes('grace period expired'));
        expect(graceExpired).to.be.false;
      } finally {
        warn.restore();
        restoreShutdownTimeout(server);
      }
    });

    it('emits http.server.closing then http.server.closed exactly once', async () => {
      await server.start();
      let closing = 0;
      let closed = 0;
      const onClosing = () => closing++;
      const onClosed = () => closed++;
      DI.on('http.server.closing', onClosing);
      DI.on('http.server.closed', onClosed);
      try {
        await server.stop();
        // idempotent second stop must not re-emit
        await server.stop();
        expect(closing).to.eq(1);
        expect(closed).to.eq(1);
      } finally {
        DI.off('http.server.closing', onClosing);
        DI.off('http.server.closed', onClosed);
      }
    });

    it('a stop() re-entered synchronously during the closing emit gets the shared promise, not null (fix 1)', async () => {
      await server.start();

      let reentrant: Promise<void> | null | undefined;
      // Container.emit is synchronous, so this listener re-enters _close() while
      // the state is already Closing. It must receive the in-flight promise -
      // if the emit fired before _closePromise was assigned it would get null.
      const onClosing = () => {
        reentrant = server.stop();
      };
      DI.on('http.server.closing', onClosing);
      try {
        const outer = server.stop();

        expect(reentrant, 're-entrant stop() must return a value').to.exist;
        expect(typeof (reentrant as Promise<void>).then).to.eq('function');

        await Promise.all([outer, reentrant]);
        expect(server.State).to.eq(LifecycleState.Closed);
      } finally {
        DI.off('http.server.closing', onClosing);
      }
    });
  });

  describe('startup (bug 4)', () => {
    it('a second start() is a no-op and attaches no middleware', async () => {
      await server.start();

      const useSpy = sinon.spy(server, 'use');
      await server.start(); // must short-circuit while Listening
      const called = useSpy.called;
      useSpy.restore();

      expect(server.State).to.eq(LifecycleState.Listening);
      expect(called, 'second start() must not attach any middleware').to.be.false;
    });

    it('start -> stop -> start restarts on the same port without re-attaching after-middlewares', async () => {
      // first start attaches the after-middlewares once for this instance
      await server.start();
      await server.stop();

      const useSpy = sinon.spy(server, 'use');
      await server.start(); // restart from Closed
      const called = useSpy.called;
      useSpy.restore();

      expect(server.State).to.eq(LifecycleState.Listening);
      // after-middlewares are attached once per instance, not once per start
      expect(called, 'restart must not re-attach after-middlewares').to.be.false;
    });

    it('emits http.server.listening exactly once per start', async () => {
      let listening = 0;
      const onListening = () => listening++;
      DI.on('http.server.listening', onListening);
      try {
        await server.start();
        await server.start(); // no-op, no second emit
        expect(listening).to.eq(1);
      } finally {
        DI.off('http.server.listening', onListening);
      }
    });

    it('a server-level error after listening is handled ( logged ), not an unhandled crash', async () => {
      await server.start();
      // start()'s per-start .once('error') is removed on listen success; the
      // persistent log-only handler from _createServer() must catch this, else
      // Node throws on an unhandled 'error' event.
      expect(() => server.Server.emit('error', new Error('synthetic post-listen error'))).to.not.throw();
    });
  });
});
