import 'mocha';
import { expect } from 'chai';
import AjvModule from 'ajv';
import { Intl } from '@spinajs/intl';
import { BadRequest, CodedHttpException, Forbidden } from '@spinajs/exceptions';
import { ValidationFailed } from '@spinajs/validation';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, PROBLEM_DETAILS_SCHEMA, toProblem, withProblemFields } from '../src/index.js';
import type { ProblemDetails, ProblemOptions } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

class LeakyError extends Error {
  public secret = 'hunter2';
  public renewUrl = '/billing';
  public code = 'leaky.code';
}

class PgLikeError extends Error {
  public code = '23505';
  public constraint = 'users_email_key';
  constructor() {
    super('duplicate key value violates unique constraint "users_email_key"');
  }
}

class OptInError extends Error {
  public static problemFields = ['code', 'reason'];
  public code = 'opt.in';
  public reason = 'because';
}

class TypedError extends Error {
  public static problemType = 'https://errors.example.com/typed';
}

const options: ProblemOptions = { includeStack: false, includeFields: [], isProduction: false, instance: '/x' };

describe('toProblem', () => {
  it('builds the standard members and drops other own properties', () => {
    const problem = toProblem(new LeakyError('boom'), 500, options);

    expect(problem).to.deep.eq({ type: 'about:blank', title: 'Leaky Error', status: 500, detail: 'boom', instance: '/x' });
    expect(problem).to.not.have.property('secret');
  });

  it('copies only the listed fields, never the reserved members', () => {
    const problem = toProblem(new LeakyError('boom'), 500, { ...options, includeFields: ['renewUrl', 'missing', 'message', 'status'] });

    expect(problem.renewUrl).to.eq('/billing');
    expect(problem).to.not.have.property('missing');
    expect(problem.status).to.eq(500);
    expect(problem).to.not.have.property('message');
  });

  it('does not let a global includeFields entry set or replace errors', () => {
    class Plain extends Error {
      public errors = ['injected'];
    }
    class Invalid extends ValidationFailed {
      public errors = ['shadow'];
    }
    expect(toProblem(new Plain('x'), 500, { ...options, includeFields: ['errors'] })).to.not.have.property('errors');
    const invalid = new Invalid('bad', [{ keyword: 'required', instancePath: '', schemaPath: '#/required', params: {} }]);
    expect(toProblem(invalid, 400, { ...options, includeFields: ['errors'] }).errors).to.deep.eq(invalid.parameter);
  });

  it('omits the stack by default and adds it only outside production when asked', () => {
    const err = new Error('boom');

    expect(toProblem(err, 500, options)).to.not.have.property('stack');
    expect(toProblem(err, 500, { ...options, includeStack: true }).stack).to.eq(err.stack);
    expect(toProblem(err, 500, { ...options, includeStack: true, isProduction: true })).to.not.have.property('stack');
  });

  it('exposes the code of framework exceptions and of classes that opt in, never of other errors', () => {
    expect(toProblem(new CodedHttpException(409, 'invoice.locked'), 409, options).code).to.eq('invoice.locked');
    expect(toProblem(new OptInError('x'), 400, options)).to.deep.include({ code: 'opt.in', reason: 'because' });
    expect(toProblem(new PgLikeError(), 500, options)).to.not.have.property('code');
  });

  it('copies the fields an error lists through withProblemFields, and only those', () => {
    const err = withProblemFields(new Forbidden('no'), { error: 'forbidden', reason: { code: 'x' } });
    (err as unknown as Record<string, unknown>).other = 1;

    const problem = toProblem(err, 403, options);

    expect(problem).to.deep.include({ error: 'forbidden', reason: { code: 'x' } });
    expect(problem).to.not.have.property('other');
    expect(Object.keys(err)).to.not.include('problemFields');
  });

  it('hides the message and code when redacting', () => {
    const problem = toProblem(new CodedHttpException(500, 'x', 'internal detail'), 500, { ...options, redact: true });

    expect(problem.detail).to.eq('Internal server error');
    expect(problem).to.not.have.property('code');
  });

  it('ignores a constructor without static members', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'constructor', { value: undefined });

    expect(toProblem(err, 500, options).type).to.eq('about:blank');
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
  public pg() {
    throw new PgLikeError();
  }

  @Get()
  public optIn() {
    throw new OptInError('refused');
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

class ProductionConfiguration extends StackConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.configuration = { isProduction: true };
  }
}

let app: TestApp | undefined;

async function startWith(configuration: typeof TestConfiguration) {
  app = await httpApp({
    configuration,
    register: (c) => c.register(ProblemController).as(BaseController),
    resolve: [Intl, Controllers],
  });
  await (await app.resolve(HttpServer)).start();
}

async function stop() {
  await app?.dispose();
  app = undefined;
}

// ajv ships CJS: under ESM the constructor is on `default`
type AjvLike = new (options: object) => { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown } };
const Ajv = ((AjvModule as unknown as { default?: AjvLike }).default ?? AjvModule) as unknown as AjvLike;

const bodyOf = (res: { body: unknown }) => res.body as ProblemDetails;

describe('problem+json error bodies', function () {
  this.timeout(15000);

  describe('defaults', () => {
    before(() => startWith(TestConfiguration));
    after(() => stop());

    it('answers application/problem+json without stack or foreign fields', async () => {
      const res = await req().get('problem/leaky').set('Accept', 'application/json');

      expect(res.status).to.eq(500);
      expect(res.type).to.eq('application/problem+json');
      expect(res.body).to.deep.eq({ type: 'about:blank', title: 'Leaky Error', status: 500, detail: 'boom', instance: '/problem/leaky' });
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

  describe('schema and redaction in development', () => {
    before(() => startWith(TestConfiguration));
    after(() => stop());

    it('validates real bodies against PROBLEM_DETAILS_SCHEMA', async () => {
      const validate = new Ajv({ strict: false }).compile(PROBLEM_DETAILS_SCHEMA);

      for (const path of ['leaky', 'forbidden', 'invalid', 'optIn']) {
        const res = await req().get(`problem/${path}`).set('Accept', 'application/json');
        expect(validate(res.body), `${path}: ${JSON.stringify(validate.errors)}`).to.eq(true);
      }
    });

    it('answers a library error with its message but without its code', async () => {
      const res = await req().get('problem/pg').set('Accept', 'application/json');

      expect(res.status).to.eq(500);
      expect(bodyOf(res).detail).to.contain('users_email_key');
      expect(res.body).to.not.have.any.keys('code', 'constraint');
    });

    it('copies the code and fields an exception class opts in to', async () => {
      const res = await req().get('problem/optIn').set('Accept', 'application/json');

      expect(res.body).to.deep.include({ code: 'opt.in', reason: 'because' });
    });

    it('answers the path as instance, without the query', async () => {
      const res = await req().get('problem/leaky?token=abc').set('Accept', 'application/json');

      expect(bodyOf(res).instance).to.eq('/problem/leaky');
    });
  });

  describe('production', () => {
    before(() => startWith(ProductionConfiguration));
    after(() => stop());

    it('hides the message and the code of an unmapped error, and the stack despite includeStack', async () => {
      const res = await req().get('problem/pg').set('Accept', 'application/json');

      expect(res.status).to.eq(500);
      expect(res.body).to.deep.eq({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Internal server error', instance: '/problem/pg' });
    });

    it('copies no extension field into a redacted 500', async () => {
      const res = await req().get('problem/leaky').set('Accept', 'application/json');

      expect(res.status).to.eq(500);
      expect(res.body).to.deep.eq({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Internal server error', instance: '/problem/leaky' });
    });

    it('keeps the message of a mapped error', async () => {
      const res = await req().get('problem/forbidden').set('Accept', 'application/json');

      expect(bodyOf(res).detail).to.eq('nope');
    });
  });

  describe('includeStack and includeFields', () => {
    before(() => startWith(StackConfiguration));
    after(() => stop());

    it('adds the stack and the listed fields', async () => {
      const res = await req().get('problem/leaky').set('Accept', 'application/json');

      expect(bodyOf(res).stack).to.be.a('string').that.contains('ProblemController');
      expect(bodyOf(res).renewUrl).to.eq('/billing');
      expect(res.body).to.not.have.property('secret');
    });
  });
});
