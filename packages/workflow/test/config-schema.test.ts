import 'mocha';
import { expect } from 'chai';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { DI, type ContainerSnapshot } from '@spinajs/di';
import { normalizeRetry, resolveWorkflowConfig, type WorkflowConfig } from '../src/index.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { rejects } from './support/rows.js';

describe('workflow configuration through the registered schema', function () {
  // Every case boots three sqlite connections, which takes seconds on a loaded machine.
  this.timeout(60_000);

  // clearCache() keeps registered values, so without a restore the schema one boot registers would validate every later
  // boot of the process, here and in other files.
  let clean: ContainerSnapshot;
  before(() => {
    clean = DI.snapshot();
  });
  afterEach(async () => {
    await disposeTestEnv();
    await DI.restore(clean);
  });

  /** Boots as an application does, so that `WorkflowBootstrapper` has registered the schema when the configuration loads. */
  const configured = async (retry: Record<string, unknown>): Promise<Partial<WorkflowConfig>> => {
    await bootTestEnv({ bootstrap: true, workflow: { retry } });
    return (await DI.resolve(Configuration)).get<Partial<WorkflowConfig>>('workflow');
  };

  it('keeps a numeric duration a number of milliseconds', async () => {
    const raw = await configured({ attempts: 3, backoff: 'fixed', delay: 5000, maxDelay: 60_000 });
    expect(raw.retry).to.deep.include({ delay: 5000, maxDelay: 60_000 });
    expect(normalizeRetry(resolveWorkflowConfig(raw).retry, 'workflow.retry')).to.deep.include({ delayMs: 5000, maxDelayMs: 60_000 });
  });

  it('keeps a zero delay', async () => {
    const raw = await configured({ attempts: 3, delay: 0 });
    expect(raw.retry).to.deep.include({ delay: 0 });
    expect(normalizeRetry(resolveWorkflowConfig(raw).retry, 'workflow.retry')).to.deep.include({ delayMs: 0 });
  });

  it('keeps a duration with a unit as written, and reads a string of digits as milliseconds', async () => {
    const raw = await configured({ attempts: 3, delay: '5s', maxDelay: '5000' });
    expect(raw.retry).to.deep.include({ delay: '5s', maxDelay: 5000 });
    expect(normalizeRetry(resolveWorkflowConfig(raw).retry, 'workflow.retry')).to.deep.include({ delayMs: 5000, maxDelayMs: 5000 });
  });

  for (const delay of [null, true, false, '', 1.5, -5, 'soon']) {
    it(`refuses the delay ${JSON.stringify(delay)} when the configuration loads`, async () => {
      const err = await rejects(configured({ attempts: 3, delay }));
      expect(err).to.be.instanceOf(InvalidConfiguration);
      expect(err.message).to.contain('workflow.retry.delay');
    });
  }
});
