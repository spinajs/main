import assert from 'node:assert/strict';
import 'mocha';
import { Config, Configuration } from '@spinajs/configuration';

import { buildCore, configuredChild, invalidOf, pinConfiguration, useHarnessLog, violationPaths } from './harness.js';

class Probe {
  @Config('authn.audit.sinkTimeoutMs')
  public Sample: number;
}

describe('harness: the authn schema applies to every boot', function () {
  this.timeout(30000);

  useHarnessLog();

  it('buildCore fails with InvalidConfiguration, naming the path, on a value the schema refuses', async () => {
    const paths = await violationPaths(buildCore({}, { raw: { authn: { freshAuth: { maxAgeSeconds: 0 } } } }));
    assert.ok(paths.includes('authn.freshAuth.maxAgeSeconds'), paths.join(', '));
  });

  it('configuredChild resolves a Configuration with the schema defaults applied', async () => {
    const child = await configuredChild({ authn: { throttle: {} } });
    try {
      assert.strictEqual(child.get(Configuration)!.get('authn.throttle.resetAfterSeconds'), 86400);
    } finally {
      await child.dispose();
    }
  });

  it('configuredChild fails with InvalidConfiguration and leaves no child behind', async () => {
    const error = await invalidOf(configuredChild({ authn: { throttle: { resetAfterSeconds: 0 } } }));
    assert.ok(error.violations.some((v) => v.path === 'authn.throttle.resetAfterSeconds'));
  });

  it('pinConfiguration points an instance built with new at the Configuration of the child', async () => {
    const child = await configuredChild({ authn: { audit: { sinkTimeoutMs: 500 } } });
    try {
      assert.strictEqual(pinConfiguration(new Probe(), child).Sample, 500);
    } finally {
      await child.dispose();
    }
  });

  it('violationPaths rethrows what is not an InvalidConfiguration', async () => {
    await assert.rejects(violationPaths(Promise.reject(new RangeError('boom'))), RangeError);
  });
});
