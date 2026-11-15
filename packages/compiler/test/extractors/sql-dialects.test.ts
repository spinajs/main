import { expect } from 'chai';
import ts from 'typescript';
import { createContext, createProgramFromTsconfig, extractSqlDialects } from '../../src/index.js';

describe('extractSqlDialects', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-sql-dialect/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-sql-dialect', 'test/fixtures/pkg-sql-dialect');
  const entries = loaded.sourceFiles.flatMap((f) => extractSqlDialects(ctx, f));
  const profile = { name: 'fixture', grammar: 'Sqlite', placeholders: 'question', families: { boolean: 'number' }, count: 'number', sum: {}, avg: {}, predicates: 'number' };

  it('the fixture type-checks against the built orm', () => {
    const errors = ts.getPreEmitDiagnostics(loaded.program).filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).to.deep.equal([]);
  });

  it('records the profile, through an imported const, with the @Injectable token of its class', () => {
    expect(entries.map((e) => ({ drivers: e.drivers, profile: e.profile, file: e.source.file }))).to.deep.equal([
      { drivers: ['orm-driver-fixture'], profile, file: 'src/driver.ts' },
      { drivers: ['orm-driver-fixture-ssh'], profile, file: 'src/driver.ts' },
    ]);
  });

  it('warns about a profile it cannot evaluate and a class without a token (CMP010)', () => {
    expect(ctx.diagnostics.filter((d) => d.code === 'CMP010').map((d) => `${d.severity} ${d.message}`)).to.deep.equal([
      'warning @SqlDialect on BrokenDriver is not recorded: placeholders must be one of question, dollar, at-p0',
      'warning @SqlDialect on UnregisteredDriver is not recorded: the class has no @Injectable string token',
      'warning @SqlDialect on ClassTokenDriver is not recorded: the class has no @Injectable string token',
    ]);
  });
});
