import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { InvalidArgument } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';
import type * as express from 'express';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, Ok, Req, SlowRequestWarning, SlowThreshold } from '../src/index.js';
import type { Request } from '../src/index.js';

@BasePath('slow-threshold')
@SlowThreshold(5000)
class SlowThresholdController extends BaseController {
  @Get()
  public inherited(@Req() request: Request) {
    return new Ok({ threshold: request.storage.slowThresholdMs ?? null });
  }

  @Get()
  @SlowThreshold(Infinity)
  public never(@Req() request: Request) {
    return new Ok({ threshold: String(request.storage.slowThresholdMs) });
  }
}

@BasePath('no-slow-threshold')
class NoSlowThresholdController extends BaseController {
  @Get()
  public plain(@Req() request: Request) {
    return new Ok({ threshold: request.storage.slowThresholdMs ?? null });
  }
}

function recording(mw: SlowRequestWarning, thresholdMs: number): unknown[][] {
  const lines: unknown[][] = [];
  for (const [key, value] of Object.entries({ Enabled: true, ThresholdMs: thresholdMs, Log: { warn: (...args: unknown[]) => lines.push(args) } })) {
    Object.defineProperty(mw, key, { value });
  }
  return lines;
}

function finished(mw: SlowRequestWarning, tookMs: number, storage: Record<string, unknown>): void {
  const request = { method: 'GET', originalUrl: '/x', headers: {}, storage } as unknown as Request;
  const ctx = { req: request, res: { statusCode: 200, locals: {} } as unknown as express.Response, storage: request.storage };
  const now = Date.now;
  try {
    Date.now = () => 1_000;
    mw.onBefore(ctx);
    Date.now = () => 1_000 + tookMs;
    mw.onFinish({ ...ctx, aborted: false });
  } finally {
    Date.now = now;
  }
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('@SlowThreshold', function () {
  this.timeout(15000);

  describe('on routes', () => {
    let app: TestApp;

    before(async () => {
      app = await httpApp({
        register: (c) => {
          c.register(SlowThresholdController).as(BaseController);
          c.register(NoSlowThresholdController).as(BaseController);
        },
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    });

    after(async () => {
      await app.dispose();
    });

    it("gives the request the controller's threshold", async () => {
      const res = await req().get('slow-threshold/inherited');
      expect(res.body).to.deep.eq({ threshold: 5000 });
    });

    it("gives the request the route's threshold over the controller's", async () => {
      const res = await req().get('slow-threshold/never');
      expect(res.body).to.deep.eq({ threshold: 'Infinity' });
    });

    it('leaves a route without it on http.slowRequest.thresholdMs', async () => {
      const res = await req().get('no-slow-threshold/plain');
      expect(res.body).to.deep.eq({ threshold: null });
    });
  });

  describe('SlowRequestWarning', () => {
    it('warns past the route threshold, below the configured one', () => {
      const mw = new SlowRequestWarning();
      const lines = recording(mw, 1000);
      finished(mw, 300, { slowThresholdMs: 200 });
      expect(lines).to.have.length(1);
      expect(lines[0][0]).to.include({ ms: 300, threshold: 200 });
    });

    it('keeps quiet below the route threshold, past the configured one', () => {
      const mw = new SlowRequestWarning();
      const lines = recording(mw, 1000);
      finished(mw, 3000, { slowThresholdMs: 5000 });
      finished(mw, 3000, { slowThresholdMs: Infinity });
      expect(lines).to.have.length(0);
    });

    it('uses the configured threshold without a route one', () => {
      const mw = new SlowRequestWarning();
      const lines = recording(mw, 1000);
      finished(mw, 1500, {});
      expect(lines).to.have.length(1);
      expect(lines[0][0]).to.include({ threshold: 1000 });
    });
  });

  it('refuses a negative or non-numeric threshold', () => {
    expect(thrownBy(() => SlowThreshold(-1))).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => SlowThreshold(Number.NaN))).to.be.instanceOf(InvalidArgument);
  });
});
