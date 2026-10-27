import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractValues } from '../../src/index.js';

describe('extractValues', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('values.ts'))!;
  const values = extractValues(ctx, file);

  it('asValue, asMapValue and registerConfigurationSchema', () => {
    expect(values).to.deep.equal([
      { token: '__basic_version__', kind: 'value', source: { file: 'src/values.ts', line: 11, col: 1, package: 'pkg-basic' } },
      { token: '__basic_map__', kind: 'map', mapKey: 'key1', source: { file: 'src/values.ts', line: 12, col: 1, package: 'pkg-basic' } },
      { token: '__configurationSchema__', kind: 'value', source: { file: 'src/values.ts', line: 13, col: 1, package: 'pkg-basic' } },
    ]);
  });
});
