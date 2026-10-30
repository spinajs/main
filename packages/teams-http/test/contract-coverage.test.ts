import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { installContractTesting, manifestOfFragments } from '@spinajs/testing';

const FRAGMENT = fileURLToPath(new URL('../lib/manifest.fragment.json', import.meta.url));

describe('contract testing coverage', () => {
  it('checks 0 routes with a derived response schema, so only problem documents are validated', async () => {
    const handle = await installContractTesting({ manifest: await manifestOfFragments([FRAGMENT]) });
    expect(handle.checkedRoutes).to.equal(0);
  });
});
