import 'mocha';
import { expect } from 'chai';

import { HealthCheck, HealthCheckRunner, IHealthResult } from './../src/health.js';

class StubCheck extends HealthCheck {
  constructor(public Name: string, private result: IHealthResult | Error, private delayMs = 0) {
    super();
  }

  public check(): Promise<IHealthResult> {
    const settle = () => (this.result instanceof Error ? Promise.reject(this.result) : Promise.resolve(this.result));

    if (this.delayMs === 0) return settle();
    return new Promise((res, rej) => setTimeout(() => settle().then(res, rej), this.delayMs));
  }
}

function makeRunner(checks: HealthCheck[], timeoutMs = 50, failOnDegraded = false) {
  const runner = new HealthCheckRunner();
  const anyRunner = runner as any;
  anyRunner.Checks = checks;
  // TimeoutMs / FailOnDegraded come from getter-only @Config accessors on the
  // prototype, so a plain assignment throws in strict mode. Define own data
  // properties on the instance to shadow the inherited getters for the test.
  Object.defineProperty(anyRunner, 'TimeoutMs', { value: timeoutMs, writable: true, configurable: true });
  Object.defineProperty(anyRunner, 'FailOnDegraded', { value: failOnDegraded, writable: true, configurable: true });
  return runner;
}

describe('HealthCheckRunner', () => {
  it('reports up with an empty check list when nothing is registered', async () => {
    const report = await makeRunner([]).run();
    expect(report.status).to.eq('up');
    expect(report.checks).to.have.length(0);
  });

  it('reports up when every check is up', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'up' }), new StubCheck('b', { status: 'up' })]).run();

    expect(report.status).to.eq('up');
    expect(report.checks).to.have.length(2);
    expect(report.checks[0].name).to.eq('a');
    expect(report.checks[0].durationMs).to.be.a('number');
  });

  it('reports down when any check is down', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'up' }), new StubCheck('b', { status: 'down', message: 'no connection' })]).run();

    expect(report.status).to.eq('down');
    const b = report.checks.find((c) => c.name === 'b')!;
    expect(b.message).to.eq('no connection');
  });

  it('down beats degraded', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'degraded' }), new StubCheck('b', { status: 'down' })]).run();
    expect(report.status).to.eq('down');
  });

  it('reports degraded when the worst check is degraded', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'up' }), new StubCheck('b', { status: 'degraded' })]).run();
    expect(report.status).to.eq('degraded');
  });

  it('treats a throwing check as down with the error message', async () => {
    const report = await makeRunner([new StubCheck('a', new Error('kaboom'))]).run();

    expect(report.status).to.eq('down');
    expect(report.checks[0].status).to.eq('down');
    expect(report.checks[0].message).to.contain('kaboom');
  });

  it('treats a check that exceeds the timeout as down', async () => {
    const report = await makeRunner([new StubCheck('slow', { status: 'up' }, 200)], 20).run();

    expect(report.status).to.eq('down');
    expect(report.checks[0].status).to.eq('down');
    expect(report.checks[0].message).to.contain('timed out');
  });

  it('does not let one slow check block the others', async () => {
    const report = await makeRunner([new StubCheck('slow', { status: 'up' }, 200), new StubCheck('fast', { status: 'up' })], 20).run();

    expect(report.checks).to.have.length(2);
    expect(report.checks.find((c) => c.name === 'fast')!.status).to.eq('up');
  });

  it('treats a status outside up|degraded|down as down rather than as harmless', async () => {
    // HealthStatus is only enforced at compile time — a JS consumer, or a check
    // forwarding a status from elsewhere, can return anything. An unranked value
    // used to compare `undefined > 0` === false, so the overall status stayed up
    // and /telemetry/ready answered 200 with a dependency down.
    const report = await makeRunner([new StubCheck('a', { status: 'up' }), new StubCheck('b', { status: 'UNHEALTHY' as any })]).run();

    expect(report.status).to.eq('down');
    expect(makeRunner([]).isFailing(report.status)).to.eq(true);

    // the check's own line keeps what it actually returned — that string is the
    // only clue an operator has that the check is misbehaving
    expect(report.checks.find((c) => c.name === 'b')!.status).to.eq('UNHEALTHY');
  });

  it('does not let a later unknown status be masked by an earlier real one', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'degraded' }), new StubCheck('b', { status: 'DOWN' as any })]).run();
    expect(report.status).to.eq('down');
  });

  it('does not let an unknown status downgrade an already-down overall status', async () => {
    const report = await makeRunner([new StubCheck('a', { status: 'down' }), new StubCheck('b', { status: 'weird' as any })]).run();
    expect(report.status).to.eq('down');
  });

  it('isFailing: down always fails, degraded only when configured', () => {
    expect(makeRunner([], 50, false).isFailing('down')).to.eq(true);
    expect(makeRunner([], 50, false).isFailing('degraded')).to.eq(false);
    expect(makeRunner([], 50, false).isFailing('up')).to.eq(false);
    expect(makeRunner([], 50, true).isFailing('degraded')).to.eq(true);
    expect(makeRunner([], 50, true).isFailing('down')).to.eq(true);
    expect(makeRunner([], 50, true).isFailing('up')).to.eq(false);
  });
});
