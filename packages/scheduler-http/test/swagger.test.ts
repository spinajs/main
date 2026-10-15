import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SwaggerService } from '@spinajs/http-swagger';

import { bootHttp, stopHttp } from './common.js';

describe('scheduler-http swagger', function () {
  // the first spec build after a rebuild scans every controller and takes tens of seconds
  this.timeout(60000);

  let spec: any;

  before(async () => {
    await bootHttp();
    spec = await (await DI.resolve(SwaggerService)).buildSpec();
  });

  after(async () => {
    await stopHttp();
  });

  const op = (method: string, path: string) => {
    const operation = spec.paths?.[path]?.[method];
    expect(operation, `${method.toUpperCase()} ${path} is not documented`).to.exist;
    return operation;
  };

  // routes declared as @Get('/') are documented with a trailing slash
  it('documents every design §7 endpoint', () => {
    op('get', '/scheduler/schedules/');
    op('get', '/scheduler/schedules/{name}');
    op('post', '/scheduler/schedules/{name}/runs');
    op('post', '/scheduler/schedules/{name}/retry-failed');
    op('post', '/scheduler/schedules/{name}/pause');
    op('post', '/scheduler/schedules/{name}/resume');
    op('get', '/scheduler/schedules/{name}/events');
    op('get', '/scheduler/runs/');
    op('get', '/scheduler/runs/{id}');
    op('get', '/scheduler/runs/{id}/events');
    op('post', '/scheduler/runs/{id}/cancel');
    op('post', '/scheduler/runs/{id}/retry');
    op('get', '/scheduler/errors/');
    op('patch', '/scheduler/errors/{fingerprint}');
    op('post', '/scheduler/prune');
  });

  it('documents both live streams as text/event-stream', () => {
    for (const path of ['/scheduler/runs/{id}/events', '/scheduler/schedules/{name}/events']) {
      expect(op('get', path).responses['200'].content).to.deep.equal({ 'text/event-stream': { schema: { type: 'string' } } });
    }
  });

  it('documents run-now as 202 with a runId body, plus 400, 404 and 409', () => {
    const responses = op('post', '/scheduler/schedules/{name}/runs').responses;

    expect(responses).to.include.keys('202', '400', '404', '409');
    expect(JSON.stringify(responses['202'])).to.contain('ISchedulerRunAccepted');
    expect(spec.components.schemas.ISchedulerRunAccepted.required).to.deep.equal(['runId']);
  });

  it('tags every operation as Scheduler and requires the cookie session', () => {
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      if (!path.startsWith('/scheduler')) continue;
      for (const operation of Object.values<any>(item)) {
        expect(operation.tags, path).to.deep.equal(['Scheduler']);
        expect(operation.security, path).to.deep.equal([{ cookieAuth: [] }]);
      }
    }
  });
});
