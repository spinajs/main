import 'mocha';
import { expect } from 'chai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

describe('@spinajs/tenancy/queue: loaded alone', function () {
  this.timeout(120000);

  it('runs a message of a tenant in a process that imports nothing else of the package', async () => {
    const args = ['--no-warnings', '--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', 'test/support/queue-subpath.ts'];
    const { stdout } = await promisify(execFile)(process.execPath, args, { cwd: new URL('..', import.meta.url), env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.json' } });
    expect(JSON.parse(stdout.trim().split('\n').pop() ?? '')).to.deep.eq({ hooks: ['TenantQueueHook'], tenant: 'acme', error: null });
  });
});
