import { expect } from 'chai';
import type { ManifestFragment } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';

const analyzed = new Map<string, Promise<ManifestFragment>>();

function fixture(name: string): Promise<ManifestFragment> {
  let fragment = analyzed.get(name);
  if (!fragment) {
    fragment = analyzePackage({ tsconfig: `test/fixtures/${name}/tsconfig.json`, packageRoot: `test/fixtures/${name}` });
    analyzed.set(name, fragment);
  }
  return fragment;
}

describe('tenant models', () => {
  let fragment: ManifestFragment;
  before(async () => {
    fragment = await fixture('tenancy-pkg');
  });

  it('marks a model by its own @Tenant, its nearest tenant base class, a literal registerTenantModel call or the fragment of a dependency', () => {
    expect(fragment.models.map((m) => [m.className, m.tenant])).to.deep.equal([
      ['Fake', undefined],
      ['Ledger', { isolation: 'schema', column: false }],
      ['Invoice', {}],
      ['Payment', { column: 'org_id', rls: true }],
      ['Country', undefined],
      ['Audit', { isolation: 'row' }],
      ['Receipt', { column: 'org_id' }],
    ]);
  });

  it('gives no member to a model whose decorator of the same name another package declares', () => {
    expect(fragment.models.find((m) => m.className === 'Fake')).to.not.have.property('tenant');
    expect(fragment.models.find((m) => m.className === 'Country')).to.not.have.property('tenant');
  });

  it('gives no model of a package without tenancy the member', async () => {
    const plain = await fixture('authz-pkg');
    expect(plain.models).to.have.length(3);
    expect(plain.models.filter((m) => 'tenant' in m)).to.deep.equal([]);
  });
});
