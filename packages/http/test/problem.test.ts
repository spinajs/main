import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { BadRequest, Forbidden } from '@spinajs/exceptions';
import { ValidationFailed } from '@spinajs/validation';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, PROBLEM_DETAILS_SCHEMA, toProblem } from '../src/index.js';
import type { ProblemDetails, ProblemOptions } from '../src/index.js';

class LeakyError extends Error {
  public secret = 'hunter2';
  public renewUrl = '/billing';
  public code = 'leaky.code';
}

class TypedError extends Error {
  public static problemType = 'https://errors.example.com/typed';
}

const options: ProblemOptions = { includeStack: false, includeFields: [], isProduction: false, instance: '/x' };

describe('toProblem', () => {
  it('builds the standard members and drops other own properties', () => {
    const problem = toProblem(new LeakyError('boom'), 500, options);

    expect(problem).to.deep.eq({ type: 'about:blank', title: 'Leaky Error', status: 500, detail: 'boom', instance: '/x', code: 'leaky.code' });
    expect(problem).to.not.have.property('secret');
  });

  it('copies only the listed fields, never the reserved members', () => {
    const problem = toProblem(new LeakyError('boom'), 500, { ...options, includeFields: ['renewUrl', 'missing', 'message', 'status'] });

    expect(problem.renewUrl).to.eq('/billing');
    expect(problem).to.not.have.property('missing');
    expect(problem.status).to.eq(500);
    expect(problem).to.not.have.property('message');
  });

  it('omits the stack by default and adds it only outside production when asked', () => {
    const err = new Error('boom');

    expect(toProblem(err, 500, options)).to.not.have.property('stack');
    expect(toProblem(err, 500, { ...options, includeStack: true }).stack).to.eq(err.stack);
    expect(toProblem(err, 500, { ...options, includeStack: true, isProduction: true })).to.not.have.property('stack');
  });

  it('leaves out the code of a system error', () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/srv/app/secret.txt'"), { code: 'EACCES', syscall: 'open' });

    expect(toProblem(err, 500, options)).to.not.have.property('code');
  });

  it('copies the static problemFields of the exception class', () => {
    class Refused extends Error {
      public static problemFields = ['reason'];
      public reason = 'expired';
      public hidden = 'x';
    }

    const problem = toProblem(new Refused('no'), 400, options);

    expect(problem.reason).to.eq('expired');
    expect(problem).to.not.have.property('hidden');
  });

  it('uses the static problemType of the exception class', () => {
    expect(toProblem(new TypedError('x'), 400, options).type).to.eq('https://errors.example.com/typed');
  });

  it('carries the validation errors of ValidationFailed', () => {
    const problem = toProblem(new ValidationFailed('invalid', [{ instancePath: '/a', schemaPath: '#/required', keyword: 'required', params: { missingProperty: 'a' }, message: 'must have a' }]), 400, options);

    expect(problem.title).to.eq('Validation Failed');
    expect(problem.errors).to.be.an('array').with.length(1);
  });

  it('exports a draft-07 schema named spinajs/http/ProblemDetails', () => {
    expect(PROBLEM_DETAILS_SCHEMA.$schema).to.eq('http://json-schema.org/draft-07/schema#');
    expect(PROBLEM_DETAILS_SCHEMA.$id).to.eq('spinajs/http/ProblemDetails');
  });
});

@BasePath('problem')
class ProblemController extends BaseController {
  @Get()
  public leaky() {
    throw new LeakyError('boom');
  }

  @Get()
  public forbidden() {
    throw new Forbidden('nope');
  }

  @Get()
  public invalid() {
    throw new ValidationFailed('invalid', [{ instancePath: '/a', schemaPath: '#/required', keyword: 'required', params: { missingProperty: 'a' }, message: 'must have a' }]);
  }

  @Get()
  public badRequest() {
    throw new BadRequest('bad input');
  }
}

class StackConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    (this.Config.http as { errors: object }).errors = { includeStack: true, includeFields: ['renewUrl'] };
  }
}

async function startWith(configuration: typeof TestConfiguration) {
  uncacheControllers();
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
  DI.register(configuration).as(Configuration);
  DI.register(ProblemController).as(BaseController);
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Intl);
  await DI.resolve(Controllers);
  await (await DI.resolve<HttpServer>(HttpServer)).start();
}

async function stop(configuration: typeof TestConfiguration) {
  await releaseHttpServer();
  DI.unregister(ProblemController as Class<unknown>);
  DI.uncache(ProblemController);
  DI.uncache(BaseController);
  DI.unregister(configuration);
  DI.uncache(Configuration);
}

const bodyOf = (res: { body: unknown }) => res.body as ProblemDetails;

describe('problem+json error bodies', function () {
  this.timeout(15000);

  describe('defaults', () => {
    before(() => startWith(TestConfiguration));
    after(() => stop(TestConfiguration));

    it('answers application/problem+json without stack or foreign fields', async () => {
      const res = await req().get('problem/leaky').set('Accept', 'application/json');

      expect(res.status).to.eq(500);
      expect(res.type).to.eq('application/problem+json');
      expect(res.body).to.deep.eq({ type: 'about:blank', title: 'Leaky Error', status: 500, detail: 'boom', instance: '/problem/leaky', code: 'leaky.code' });
    });

    it('uses the mapped response status', async () => {
      const res = await req().get('problem/forbidden').set('Accept', 'application/json');

      expect(res.status).to.eq(403);
      expect(res.type).to.eq('application/problem+json');
      expect(bodyOf(res).status).to.eq(403);
      expect(bodyOf(res).title).to.eq('Forbidden');
    });

    it('adds errors for ValidationFailed', async () => {
      const res = await req().get('problem/invalid').set('Accept', 'application/json');

      expect(res.status).to.eq(400);
      expect(bodyOf(res).errors).to.be.an('array').with.length(1);
    });

    it('keeps rendering HTML for clients that ask for it', async () => {
      const res = await req().get('problem/badRequest').set('Accept', 'text/html');

      expect(res.status).to.eq(400);
      expect(res.type).to.eq('text/html');
      expect(res.text).to.contain('bad input');
    });
  });

  describe('includeStack and includeFields', () => {
    before(() => startWith(StackConfiguration));
    after(() => stop(StackConfiguration));

    it('adds the stack and the listed fields', async () => {
      const res = await req().get('problem/leaky').set('Accept', 'application/json');

      expect(bodyOf(res).stack).to.be.a('string').that.contains('ProblemController');
      expect(bodyOf(res).renewUrl).to.eq('/billing');
      expect(res.body).to.not.have.property('secret');
    });
  });
});
