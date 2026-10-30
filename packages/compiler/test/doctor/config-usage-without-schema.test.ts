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

  it('accepts paths under a dotted module and names the shared prefix for typos', () => {
    const m = fixture({
      configModules: [
        { module: 'authz.fs', schemaId: 'a', source: src('src/s.ts') },
        { module: 'authz.http.access', schemaId: 'b', source: src('src/s.ts') },
      ],
      configUsages: [
        { path: 'authz.fs.x', source: src('src/a.ts', 1) },
        { path: 'authz.http.typo', source: src('src/b.ts', 2) },
      ],
    });
    expect(configUsageWithoutSchema.run(m, ctx)).to.deep.equal([
      { code: 'CFG001', severity: 'warning', message: "Config path 'authz.http.typo' is read but no configuration schema declares module 'authz.http'", source: src('src/b.ts', 2) },
    ]);
  });

  it('ignores the roots the configuration fills itself but still reports other roots beside them', () => {
    const m = fixture({
      configUsages: [
        { path: 'configuration.isProduction', source: src('src/a.ts') },
        { path: 'process.env.APP_ENV', source: src('src/b.ts') },
        { path: 'billing.key', source: src('src/c.ts') },
      ],
    });
    expect(configUsageWithoutSchema.run(m, ctx).map((d) => d.message)).to.deep.equal(["Config path 'billing.key' is read but no configuration schema declares module 'billing'"]);
  });
});
