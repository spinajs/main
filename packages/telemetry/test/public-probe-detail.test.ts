import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { BaseController, BasePolicy } from '@spinajs/http';
import { testHost } from '@spinajs/authz-testing';

import { TEST_TOKEN } from './common.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { HealthCheck, HealthCheckRunner, TelemetryAccessPolicy } from './../src/index.js';
import type { IHealthCheckReport, IHealthResult, IReadyReport } from './../src/index.js';

class ThrowingCheck extends HealthCheck {
  public Name = 'database';

  public check(): Promise<IHealthResult> {
    return Promise.reject(new Error('secret: SQLITE_CANTOPEN /srv/app/data.sqlite'));
  }
}

class ErrorDataCheck extends HealthCheck {
  public Name = 'pump';

  public check(): Promise<IHealthResult> {
    return Promise.resolve({ status: 'degraded', message: 'pump readings are stale', data: { ageS: 12, error: 'fetch failed for /api/forecast?site=42' } });
  }
}

class FailingDetailPolicy extends BasePolicy {
  public isEnabled() {
    return true;
  }
  public execute(): Promise<void> {
    return Promise.reject(new Error('the detail policy is broken'));
  }
}

type ProbeController = { Health: HealthCheckRunner; ProbeDetail: TelemetryAccessPolicy };

describe('public probes carry no internal detail', function () {
  this.timeout(15000);

  let app: TestApp;
  let controller: ProbeController;
  let mounted: HealthCheckRunner;
  let warn: sinon.SinonSpy;
  const logged: unknown[][] = [];

  const anonymous = (path: string) => app.request().get(path).set('Accept', 'application/json');
  const line = (body: unknown, name: string): IHealthCheckReport | undefined => (body as IReadyReport).checks.find((c) => c.name === name);
  const withToken = (path: string) => anonymous(path).set('x-metrics-token', TEST_TOKEN);

  before(async () => {
    app = await startApp({ rbac: true });

    // The mounted controller instance can outlive an earlier boot of the suite, so its runner is replaced here.
    const loaded = await (app.controllers as unknown as { Controllers: Promise<Array<{ name: string; instance: BaseController }>> }).Controllers;
    controller = loaded.find((c) => c.name === 'TelemetryController')!.instance as unknown as ProbeController;
    mounted = controller.Health;

    const runner = new HealthCheckRunner();
    const record = (...args: unknown[]) => logged.push(args);
    warn = sinon.spy(record);
    Object.defineProperty(runner, 'Checks', { value: [new ThrowingCheck(), new ErrorDataCheck()] });
    Object.defineProperty(runner, 'Log', { value: { warn, error: record, info: record, debug: record, trace: record } });
    controller.Health = runner;
  });

  after(async () => {
    controller.Health = mounted;
    await stopApp();
  });

  describe('GET /telemetry/ready', () => {
    it('answers an anonymous caller without the message of a thrown check', async () => {
      const res = await anonymous('/telemetry/ready');

      expect(res).to.have.status(503);
      expect(res.text).to.not.include('secret');
      expect(line(res.body, 'database')).to.include({ status: 'down' });
    });

    it('logs the message of a thrown check once per run', async () => {
      warn.resetHistory();
      logged.length = 0;

      await anonymous('/telemetry/ready');

      const mentions = logged.filter((args) => args.some((a) => (a instanceof Error ? a.message : String(a)).includes('secret')));
      expect(mentions, 'the thrown message must reach the log exactly once').to.have.length(1);
      expect(warn.calledOnce).to.eq(true);
    });

    it('answers an anonymous caller without a check data.error, keeping the rest of its line', async () => {
      const res = await anonymous('/telemetry/ready');
      const pump = line(res.body, 'pump');

      expect(res.text).to.not.include('fetch failed');
      expect(pump?.message).to.eq('pump readings are stale');
      expect(pump?.data).to.deep.eq({ ageS: 12 });
    });

    it('shows a check data.error to a caller holding telemetry:read, never the thrown message', async () => {
      const res = await withToken('/telemetry/ready');
      const pump = line(res.body, 'pump');

      expect(res).to.have.status(503);
      expect(pump?.data).to.deep.eq({ ageS: 12, error: 'fetch failed for /api/forecast?site=42' });
      expect(res.text).to.not.include('secret');
    });
  });

  describe('GET /telemetry/health', () => {
    it('answers an anonymous caller with the status only', async () => {
      const res = await anonymous('/telemetry/health');

      expect(res).to.have.status(200);
      expect(res.body).to.deep.eq({ status: 'up' });
    });

    it('answers a caller holding telemetry:read with the process detail', async () => {
      const res = await withToken('/telemetry/health');

      const body = res.body as Record<string, unknown>;

      expect(res).to.have.status(200);
      expect(body.status).to.eq('up');
      expect(body.pid).to.eq(process.pid);
      expect(body.node).to.eq(process.version);
      expect(body.uptimeMs).to.be.a('number');
      expect(body.startedAt).to.be.a('number');
    });

    it('answers a caller with a wrong token with the status only, not an error', async () => {
      const res = await anonymous('/telemetry/health').set('x-metrics-token', 'not-the-token');

      expect(res).to.have.status(200);
      expect(res.body).to.deep.eq({ status: 'up' });
    });
  });

  describe('a probe detail check that fails', () => {
    const slot = ['telemetry', 'auth', 'policies', 'probeDetail'];
    let mountedDetail: TelemetryAccessPolicy;
    let configured: unknown;

    // A fresh policy for the slot value, mounted on the controller, with its log replaced by a spy.
    const mountDetail = (value: unknown) => {
      testHost.config().set(slot, value);
      const policy = DI.resolve(TelemetryAccessPolicy, ['probeDetail']);
      const spy = sinon.spy();
      Object.defineProperty(policy, 'Log', { value: { warn: spy, error: spy, info: spy, debug: spy, trace: spy } });
      controller.ProbeDetail = policy;
      return spy;
    };

    before(() => {
      mountedDetail = controller.ProbeDetail;
      configured = testHost.config().get(slot.join('.'));
      DI.register(FailingDetailPolicy).as(BasePolicy);
    });

    after(() => {
      controller.ProbeDetail = mountedDetail;
      testHost.config().set(slot, configured);
      DI.unregister(FailingDetailPolicy);
      DI.uncache(FailingDetailPolicy);
      DI.uncache(BasePolicy);
    });

    it('with an error other than a refusal answers with the status only and logs the error once', async () => {
      const log = mountDetail('FailingDetailPolicy');

      const res = await withToken('/telemetry/health');

      expect(res).to.have.status(200);
      expect(res.body).to.deep.eq({ status: 'up' });
      expect(log.calledOnce, 'the failure must reach the log once').to.eq(true);
      expect((log.firstCall.args[0] as Error).message).to.eq('the detail policy is broken');
    });

    it('logs nothing for a refusal', async () => {
      const log = mountDetail(configured);

      const res = await anonymous('/telemetry/health');

      expect(res.body).to.deep.eq({ status: 'up' });
      expect(log.called, 'a 401 is normal flow on a public probe').to.eq(false);
    });
  });
});
