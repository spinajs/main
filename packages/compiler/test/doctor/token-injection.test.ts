import 'mocha';
import { expect } from 'chai';
import { analyzePackage } from '../../src/index.js';
import { unresolvedInjection } from '../../src/doctor/rules/unresolved-injection.js';
import { fixture } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('DI001 with token constants', () => {
  it('resolves token injections against token registrations and still reports an unregistered token', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/tokens/tsconfig.json', packageRoot: 'test/fixtures/tokens', schemaDerivation: false });
    const manifest = fixture({ services: fragment.services, values: fragment.values });
    expect(unresolvedInjection.run(manifest, ctx).map((d) => d.message)).to.deep.equal([
      "NeedsMissing injects '__unregistered__' (constructor argument 0) but nothing registers it",
    ]);
  });
});
