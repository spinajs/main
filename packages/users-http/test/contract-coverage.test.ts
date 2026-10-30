import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { installContractTesting, manifestOfFragments } from '@spinajs/testing';

const FRAGMENTS = ['users-http', 'authz-http-admin'].map((name) => fileURLToPath(new URL(`../../${name}/lib/manifest.fragment.json`, import.meta.url)));

describe('contract testing coverage', () => {
  it('checks 14 routes with a derived response schema', async () => {
    const handle = await installContractTesting({ manifest: await manifestOfFragments(FRAGMENTS) });
    expect(handle.checkedRoutes).to.equal(14);
  });
});
