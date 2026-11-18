import 'mocha';
import { expect } from 'chai';
import express from 'express';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { releaseHttpServer, req, TestConfiguration } from './common.js';
import { HttpServer, ServerMiddleware } from '../src/index.js';

const calls: string[] = [];

function recorder(name: string) {
  return (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    calls.push(name);
    next();
  };
}

class UnorderedMiddleware extends ServerMiddleware {
  public before() {
    return recorder('unordered');
  }

  public after(): null {
    return null;
  }
}

class LateMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public before() {
    return recorder('late');
  }

  public after(): null {
    return null;
  }
}

class EarlyMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = -10;
  }

  public before() {
    return recorder('early');
  }

  public after(): null {
    return null;
  }
}

const probes = [UnorderedMiddleware, LateMiddleware, EarlyMiddleware];

describe('Server middleware without Order', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    for (const probe of probes) {
      DI.register(probe).as(ServerMiddleware);
    }
    await DI.resolve(Configuration);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    for (const probe of probes) {
      DI.unregister(probe);
      DI.uncache(probe);
    }
    DI.uncache(ServerMiddleware);
  });

  it('defaults Order to 0', () => {
    expect(new UnorderedMiddleware().Order).to.eq(0);
  });

  it('runs between middlewares with a negative and a positive Order', async () => {
    await req().get('no-such-route');
    expect(calls).to.deep.eq(['early', 'unordered', 'late']);
  });
});
