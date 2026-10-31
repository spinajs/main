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
  it('recognises Configuration subclasses and Configuration | undefined receivers', () => {
    const receivers = loaded.sourceFiles.find((f) => f.fileName.endsWith('config-receivers.ts'))!;
    expect(extractConfigUsages(ctx, receivers).map((u) => u.path)).to.deep.equal(['basic.sub', 'basic.maybe']);
  });
  describe('a schema with parts that are not plain literals', () => {
    const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
    const unitCtx = createContext(unit, 'unit', 'test/fixtures/unit');
    extractConfigModules(unitCtx, unit.sourceFiles.find((f) => f.fileName.endsWith('config-literals.ts'))!);
    const readable = unitCtx.schemas['spinajs/readable.configuration.schema.json'] as Record<string, unknown>;
    const unreadable = unitCtx.schemas['spinajs/unreadable.configuration.schema.json'] as Record<string, unknown>;

    it('reads spreads of arrays and Object.freeze, and keeps a literal null', () => {
      expect(readable.properties).to.deep.equal({
        store: { type: 'string', enum: ['a', 'b', 'c', 'e'] },
        list: { type: 'array', default: ['d'] },
        frozen: { enum: ['a', 'b'] },
        nothing: { default: null, anyOf: [{ const: null }, { type: 'string' }] },
      });
      expect(readable).to.not.have.property('x-explicit');
    });

    it('publishes what it cannot read as partial, with no hole in it', () => {
      expect(JSON.parse(JSON.stringify(unreadable))).to.deep.equal({
        $id: 'spinajs/unreadable.configuration.schema.json',
        $configurationModule: 'unreadable',
        type: 'object',
        properties: { some: { anyOf: [{ const: null }] }, none: { type: 'string' } },
        'x-explicit': 'partial',
      });
    });

    it('reports what it could not read', () => {
      expect(unitCtx.diagnostics.filter((d) => d.code === 'CMP001')).to.not.have.length(0);
    });
  });

  it('recognises a generic Configuration subclass receiver', () => {
    const generic = loaded.sourceFiles.find((f) => f.fileName.endsWith('generic-bases.ts'))!;
    expect(extractConfigUsages(ctx, generic).map((u) => u.path)).to.deep.equal(['basic.generic']);
  });
});
