import { expect } from 'chai';
import ts from 'typescript';
import { analyzePackage, createContext, createProgramFromTsconfig, extractSqlQueries } from '../../src/index.js';

describe('extractSqlQueries', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-sql/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-sql', 'test/fixtures/pkg-sql');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('queries.ts'))!;
  const at = (line: number, col: number) => ({ file: 'src/queries.ts', line, col, package: 'pkg-sql' });

  it('the fixture type-checks under typescript 5.9 (orm built with sql<R> and executeSql)', () => {
    const errors = ts.getPreEmitDiagnostics(loaded.program).filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).to.deep.equal([]);
  });

  it('records every sql template of @spinajs/orm and nothing else', () => {
    expect(extractSqlQueries(ctx, file)).to.deep.equal([
      { id: 'src/queries.ts:5:20', text: 'SELECT Id, Email FROM users', placeholders: 0, dynamic: false, source: at(5, 20) },
      {
        id: 'src/queries.ts:6:22',
        text: 'SELECT Id, Email FROM users WHERE Id = ?',
        placeholders: 1,
        dynamic: false,
        declaredRow: { text: '{ Id: number; Email: string | null; }' },
        declaredColumns: [
          { name: 'Id', ts: 'number', nullable: false },
          { name: 'Email', ts: 'string', nullable: true },
        ],
        source: at(6, 22),
      },
      { id: 'src/queries.ts:7:23', text: 'SELECT Id FROM users WHERE ?', placeholders: 0, dynamic: true, source: at(7, 23) },
      { id: 'src/queries.ts:7:56', text: 'Id = ?', placeholders: 1, dynamic: false, source: at(7, 56) },
      { id: 'src/queries.ts:8:20', text: 'SELECT ? FROM users', placeholders: 0, dynamic: true, source: at(8, 20) },
      { id: 'src/queries.ts:9:21', text: 'SELECT Id FROM users WHERE Id IN (?)', placeholders: 1, dynamic: false, lists: [0], source: at(9, 21) },
      { id: 'src/queries.ts:10:61', text: 'SELECT Id FROM posts', placeholders: 0, dynamic: false, connection: 'reports', source: at(10, 61) },
    ]);
  });

  it('analyzePackage puts them in the fragment; a package without templates has no section', async () => {
    const withSql = await analyzePackage({ tsconfig: 'test/fixtures/pkg-sql/tsconfig.json', packageRoot: 'test/fixtures/pkg-sql' });
    expect(withSql.sqlQueries).to.have.length(7);
    const without = await analyzePackage({ tsconfig: 'test/fixtures/pkg-models-v2/tsconfig.json', packageRoot: 'test/fixtures/pkg-models-v2' });
    expect(without).to.not.have.property('sqlQueries');
  });
});
