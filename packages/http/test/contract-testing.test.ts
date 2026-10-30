import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { ResourceNotFound } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, CONTRACT_VALIDATOR, CONTRACT_VIOLATIONS, Controllers, Get, HandleException, HttpServer, NotFound, Ok } from '../src/index.js';
import type { ContractValidator, ContractViolation, ContractViolations } from '../src/index.js';

@HandleException(ResourceNotFound)
class ContractNotFound extends NotFound {}

@BasePath('contract')
class ContractController extends BaseController {
  @Get()
  public good() {
    return new Ok({ id: 1 });
  }

  @Get()
  public bad() {
    return new Ok({ name: 'no id' });
  }

  @Get()
  public unchecked() {
    return new Ok({ anything: true });
  }

  @Get()
  public missing() {
    throw new ResourceNotFound('nothing here');
  }
}

const requiresId = (body: unknown): unknown[] | null => (typeof body === 'object' && body !== null && 'id' in body ? null : [{ message: "must have required property 'id'" }]);

class StubValidator implements ContractValidator {
  public problems: unknown[] = [];

  public checkResponse(route: { handler: string }, body: unknown): unknown[] | null {
    return route.handler === 'unchecked' ? null : requiresId(body);
  }

  public checkSchema(_schema: object, body: unknown): unknown[] | null {
    this.problems.push(body);
    return (body as { title?: unknown }).title === undefined ? [{ message: 'no title' }] : null;
  }
}

class Violations implements ContractViolations {
  public list: ContractViolation[] = [];
  public get count(): number {
    return this.list.length;
  }
  public record(violation: ContractViolation): void {
    this.list.push(violation);
  }
}

describe('response contract validation', function () {
  this.timeout(60000);

  let app: TestApp;
  let violations: Violations;
  let validator: StubValidator;

  async function boot(contractTesting: Record<string, unknown>) {
    violations = new Violations();
    validator = new StubValidator();
    app = await httpApp({
      register: (c) => {
        c.register(ContractController).as(BaseController);
        c.register(ContractNotFound).asSelf();
        c.register(validator).asValue(CONTRACT_VALIDATOR.key);
        c.register(violations).asValue(CONTRACT_VIOLATIONS.key);
      },
      resolve: [Intl, Controllers],
    });
    app.config.set('http.contractTesting', contractTesting);
    await (await app.resolve(HttpServer)).start();
  }

  afterEach(async () => {
    await app.dispose();
  });

  it('lets a body that matches its schema through and records nothing', async () => {
    await boot({ enabled: true, mode: 'throw' });
    const res = await req().get('contract/good');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ id: 1 });
    expect(violations.count).to.eq(0);
  });

  it('answers 500 and records the violation for a body missing a required property', async () => {
    await boot({ enabled: true, mode: 'throw' });
    const res = await req().get('contract/bad');
    expect(res.status).to.eq(500);
    expect(violations.count).to.eq(1);
    expect(violations.list[0]).to.deep.include({ controller: 'ContractController', handler: 'bad', kind: 'response', status: 200 });
    expect(violations.list[0].errors).to.deep.eq([{ message: "must have required property 'id'" }]);
  });

  it('only records the violation in log mode and still sends the body', async () => {
    await boot({ enabled: true, mode: 'log' });
    const res = await req().get('contract/bad');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ name: 'no id' });
    expect(violations.count).to.eq(1);
  });

  it('does not check a route without a schema', async () => {
    await boot({ enabled: true, mode: 'throw' });
    expect((await req().get('contract/unchecked')).status).to.eq(200);
    expect(violations.count).to.eq(0);
  });

  it('checks nothing while contract testing is off', async () => {
    await boot({ enabled: false, mode: 'throw' });
    expect((await req().get('contract/bad')).status).to.eq(200);
    expect(violations.count).to.eq(0);
    expect(validator.problems).to.have.length(0);
  });

  it('validates an error response as a problem document', async () => {
    await boot({ enabled: true, mode: 'throw' });
    const res = await req().get('contract/missing');
    expect(res.status).to.eq(404);
    expect(res.type).to.eq('application/problem+json');
    expect(validator.problems).to.have.length(1);
    expect(violations.count).to.eq(0);
  });

  it('validates the error response of a route that no controller answers', async () => {
    await boot({ enabled: true, mode: 'throw' });
    expect((await req().get('contract/nowhere')).status).to.eq(404);
    expect(validator.problems).to.have.length(1);
  });
});
