import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractConfigModules } from '../../src/index.js';

describe('a configuration schema registered from another package', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/config-imported/tsconfig.json');
  const ctx = createContext(loaded, 'config-imported', 'test/fixtures/config-imported');
  const modules = extractConfigModules(ctx, loaded.sourceFiles.find((f) => f.fileName.endsWith('register.ts'))!);
  const cfg010 = ctx.diagnostics.filter((d) => d.code === 'CFG010');
  const lines = cfg010.map((d) => d.source?.line);

  it('is left to the package whose declaration it is bound to: no CFG010, no module', () => {
    expect(modules).to.deep.equal([]);
    expect(lines).to.not.include(10);
    expect(lines).to.not.include(11);
  });

  it('still warns CFG010 for a schema of its own the build cannot read, also one typed by a declaration file', () => {
    expect(lines).to.deep.equal([15, 16]);
    for (const d of cfg010) expect(d.message).to.equal('configuration schema is not a literal with $id and $configurationModule');
  });
});
