import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractMigrations } from '../../src/index.js';

describe('extractMigrations', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('migration.ts'))!;

  it('connection, env and file', () => {
    expect(extractMigrations(ctx, file)).to.deep.equal([
      {
        id: 'pkg-basic:Posts_2026_01_01_00_00_00',
        className: 'Posts_2026_01_01_00_00_00',
        connection: 'default',
        env: ['test'],
        file: 'src/migration.ts',
        source: { file: 'src/migration.ts', line: 3, col: 1, package: 'pkg-basic' },
      },
    ]);
  });
});
