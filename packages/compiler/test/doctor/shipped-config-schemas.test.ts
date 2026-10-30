import 'mocha';
import { expect } from 'chai';
import { analyzePackage } from '../../src/index.js';
import { configUsageWithoutSchema } from '../../src/doctor/rules/config-usage-without-schema.js';
import { fixture } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

const SHIPPED: Array<{ pkg: string; module: string }> = [
  { pkg: 'fs', module: 'fs' },
  { pkg: 'templates', module: 'templates' },
  { pkg: 'intl', module: 'intl' },
  { pkg: 'http', module: 'https' },
];

describe('CFG001 on packages that ship configuration', () => {
  for (const { pkg, module } of SHIPPED) {
    it(`@spinajs/${pkg} declares a schema for '${module}', so the rule stays quiet about it`, async () => {
      const fragment = await analyzePackage({ tsconfig: `../${pkg}/tsconfig.json`, packageRoot: `../${pkg}` });
      expect(fragment.configModules.map((m) => m.module)).to.include(module);
      expect(fragment.diagnostics.filter((d) => d.code === 'CFG010')).to.deep.equal([]);

      const findings = configUsageWithoutSchema.run(fixture({ configModules: fragment.configModules, configUsages: fragment.configUsages }), ctx);
      expect(findings.filter((d) => d.message.includes(`module '${module}`))).to.deep.equal([]);
    }).timeout(180_000);
  }
});
