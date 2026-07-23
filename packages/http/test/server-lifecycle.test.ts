import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { HttpServer } from '../src/server.js';
import { LifecycleState } from '../src/interfaces.js';
import { TestConfiguration } from './common.js';

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

    it('stop() is awaitable and the port is immediately re-bindable (bug 3)', async () => {
      await server.start();
      await server.stop();
      // if the port were still held this second listen would EADDRINUSE
      await server.start();
      expect(server.State).to.eq(LifecycleState.Listening);
    });

    it('dispose() on a cleanly-closed server resolves quickly (bug 1)', async () => {
      await server.start();
      const start = process.hrtime.bigint();
      await server.dispose();
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // the old code left a 5s timer pending; a clean close must be well under it
      expect(ms).to.be.lessThan(2000);
    });

    it('emits http.server.closing then http.server.closed exactly once', async () => {
      await server.start();
      let closing = 0;
      let closed = 0;
      DI.on('http.server.closing', () => closing++);
      DI.on('http.server.closed', () => closed++);
      await server.stop();
      // idempotent second stop must not re-emit
      await server.stop();
      expect(closing).to.eq(1);
      expect(closed).to.eq(1);
    });
  });
});
