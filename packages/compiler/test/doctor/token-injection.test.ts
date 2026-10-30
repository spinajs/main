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

describe('DI001 with unresolvable token keys', () => {
  it('skips an unreadable key even when a class carries the constant name, and still reports a real gap', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/tokens-lib/tsconfig.json', packageRoot: 'test/fixtures/tokens-lib', schemaDerivation: false });
    const manifest = fixture({ services: fragment.services, values: fragment.values });
    const messages = unresolvedInjection.run(manifest, ctx).map((d) => d.message);
    expect(messages).to.include("NeedsMissing injects 'mail.missing' (constructor argument 0) but nothing registers it");
    expect(messages.filter((m) => m.includes('Unreadable') || m.includes('unresolved') || m.includes('LOCAL_DYNAMIC'))).to.deep.equal([]);
  });
});
