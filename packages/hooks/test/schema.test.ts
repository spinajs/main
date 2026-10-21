import * as chai from 'chai';
import 'mocha';

import { boot, disposeChildren, rejectionOf } from './support.js';

const expect = chai.expect;

describe('hooks configuration schema', function () {
  this.timeout(10000);

  afterEach(disposeChildren);

  it('fills the defaults', async () => {
    const { child } = await boot({});
    const { Configuration } = await import('@spinajs/configuration');
    const configuration = await child.resolve(Configuration);

    expect(configuration.get('hooks.timeoutMs')).to.eq(5000);
    expect(configuration.get('hooks.maxDepth')).to.eq(8);
  });

  for (const [key, value] of [
    ['timeoutMs', 0],
    ['timeoutMs', 60001],
    ['maxDepth', 0],
    ['maxDepth', 33],
  ] as const) {
    it(`rejects hooks.${key} = ${value}`, async () => {
      const e = await rejectionOf(boot({ hooks: { [key]: value } }));

      expect(String((e as Error).message)).to.contain(key);
    });
  }

  it('accepts the bounds', async () => {
    await boot({ hooks: { timeoutMs: 60000, maxDepth: 32 } });
    await boot({ hooks: { timeoutMs: 1, maxDepth: 1 } });
  });

  it('accepts the __file__ tag a config file source adds to the hooks section', async () => {
    await boot({ hooks: { maxDepth: 4, __file__: ['node_modules/@spinajs/hooks/lib/mjs/config/hooks.js'] } });
  });

  it('rejects an unknown key under hooks', async () => {
    const e = await rejectionOf(boot({ hooks: { maxDepth: 4, timeout: 5 } }));

    expect(String((e as Error).message)).to.contain('timeout');
  });
});
