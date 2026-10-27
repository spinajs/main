import 'mocha';
import { expect } from 'chai';
import { configUsageWithoutSchema } from '../../src/doctor/rules/config-usage-without-schema.js';
import { fixture, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('CFG001 config-usage-without-schema', () => {
  it('reports paths whose module has no schema, once per path', () => {
    const m = fixture({
      configModules: [{ module: 'hooks', schemaId: 'spinajs/hooks.configuration.schema.json', source: src('src/schema.ts') }],
      configUsages: [
        { path: 'hooks.timeoutMs', source: src('src/a.ts', 1) },
        { path: 'system.dirs.cli', source: src('src/b.ts', 1) },
        { path: 'billing.apiKey', source: src('src/c.ts', 3) },
        { path: 'billing.apiKey', source: src('src/d.ts', 9) },
      ],
    });
    expect(configUsageWithoutSchema.run(m, ctx)).to.deep.equal([
      { code: 'CFG001', severity: 'warning', message: "Config path 'billing.apiKey' is read but no configuration schema declares module 'billing'", source: src('src/c.ts', 3) },
    ]);
  });
});
