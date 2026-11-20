import 'mocha';
import { expect } from 'chai';
import { once } from 'node:events';
// registers the idempotency stores and schema before the boot
import '@spinajs/idempotency';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, BasePolicy, CONTRACT_VALIDATOR, CONTRACT_VIOLATIONS, Controllers, Get, HttpServer, Middleware, Ok, Policy, Req, RouteMiddleware } from '../src/index.js';
import type { ContractValidator, ContractViolation, ContractViolations, MiddlewareStage, Request } from '../src/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let policyCalls = 0;

class SlowBeforePolicy extends RouteMiddleware {
  public readonly Stage: MiddlewareStage = 'beforePolicy';

  public isEnabled(): boolean {
    return true;
  }

  public async onBefore(): Promise<void> {
    await sleep(600);
  }
}

class CountingPolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    policyCalls++;
  }
}

class StubValidator implements ContractValidator {
  public responses: { handler: string; status?: number }[] = [];

  public checkResponse(route: { handler: string }, body: unknown, status?: number): unknown[] | null {
    this.responses.push({ handler: route.handler, status });
    return typeof body === 'object' && body !== null && 'id' in body ? null : [{ message: "must have required property 'id'" }];
  }

  public checkSchema(): unknown[] | null {
    return null;
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

@BasePath('deadline-integration')
class DeadlineIntegrationController extends BaseController {
  @Get()
  public async late(@Req() req: Request) {
    await once(req.storage.signal!, 'abort');
    await sleep(20);
    return new Ok({ id: 1 });
  }

  @Get('slow-gate')
  @Middleware(SlowBeforePolicy)
  @Policy(CountingPolicy)
  public slowGate() {
    return new Ok({ id: 1 });
  }
}

class DeadlineIntegrationConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const config = this.Config as { http: Record<string, unknown> };
    config.http.deadline = { enabled: true, ms: 300 };
    config.http.contractTesting = { enabled: true, mode: 'throw' };
  }
}

describe('request deadline with contract testing and the beforePolicy stage', function () {
  this.timeout(30000);

  let app: TestApp;
  let validator: StubValidator;
  let violations: Violations;

  before(async () => {
    validator = new StubValidator();
    violations = new Violations();
    app = await httpApp({
      configuration: DeadlineIntegrationConfiguration,
      register: (c) => {
        c.register(DeadlineIntegrationController).as(BaseController);
        c.register(validator).asValue(CONTRACT_VALIDATOR.key);
        c.register(violations).asValue(CONTRACT_VIOLATIONS.key);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  beforeEach(() => {
    validator.responses = [];
    violations.list = [];
  });

  it('sends the 504 in place of a route reply without checking it against the route schema', async () => {
    const res = await req().get('deadline-integration/late').set('Accept', 'application/json');
    expect(res.status).to.eq(504);
    expect((res.body as { error: { code: string } }).error.code).to.eq('deadline_exceeded');
    expect(validator.responses.filter((r) => r.handler === 'late')).to.deep.eq([]);
    expect(violations.count).to.eq(0);
  });

  it('does not evaluate the policies after a deadline fired during a slow beforePolicy middleware', async () => {
    policyCalls = 0;
    const res = await req().get('deadline-integration/slow-gate').set('Accept', 'application/json');
    expect(res.status).to.eq(504);
    await sleep(500);
    expect(policyCalls).to.eq(0);
  });
});
