import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractConfigModules, extractConfigUsages } from '../../src/index.js';

describe('config extractors', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const values = loaded.sourceFiles.find((f) => f.fileName.endsWith('values.ts'))!;
  const services = loaded.sourceFiles.find((f) => f.fileName.endsWith('services.ts'))!;
  const conditions = loaded.sourceFiles.find((f) => f.fileName.endsWith('conditions.ts'))!;

  it('registerConfigurationSchema(constant) yields a module with defaults file', () => {
    expect(extractConfigModules(ctx, values)).to.deep.equal([
      {
        module: 'basic',
        schemaId: 'spinajs/basic.configuration.schema.json',
        defaultsFile: 'src/config/basic.ts',
        source: { file: 'src/values.ts', line: 13, col: 1, package: 'pkg-basic' },
      },
    ]);
    expect(ctx.schemas['spinajs/basic.configuration.schema.json']).to.deep.include({ $configurationModule: 'basic', type: 'object' });
  });
  it('@Config and config.get literals become usages', () => {
    expect(extractConfigUsages(ctx, services)).to.deep.equal([
      { path: 'basic.greeting', source: { file: 'src/services.ts', line: 22, col: 3, package: 'pkg-basic' } },
    ]);
    expect(extractConfigUsages(ctx, conditions).map((u) => u.path)).to.deep.equal(['basic.featureB', 'basic.featureC']);
  });
});
