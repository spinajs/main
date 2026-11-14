import { expect } from 'chai';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgramFromTsconfig } from '../../src/program.js';
import { deriveSchema, type JsonSchema } from '../../src/schema/derive.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'schema-symbols');
const EXPORTS = ['WithSymbols', 'Combined', 'Mapped', 'Tagged', 'Validator'];

function deriveAll(): Record<string, JsonSchema> {
  const { program } = createProgramFromTsconfig(path.join(DIR, 'tsconfig.json'));
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path.join(DIR, 'types.ts'));
  if (!file) throw new Error('fixture types.ts not in program');
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (!moduleSymbol) throw new Error('fixture has no module symbol');
  const out: Record<string, JsonSchema> = {};
  for (const name of EXPORTS) {
    const symbol = checker.getExportsOfModule(moduleSymbol).find((s) => s.name === name);
    if (!symbol?.declarations?.length) throw new Error(`fixture export ${name} not found`);
    out[name] = deriveSchema(checker, checker.getDeclaredTypeOfSymbol(symbol), symbol.declarations[0], { idPrefix: 'fixture/', maxDepth: 20 }, new Map()).schema;
  }
  return out;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('schema derivation of symbol-keyed members', () => {
  it('is identical when TypeScript symbol ids differ', () => {
    const cold = deriveAll();
    // Burn symbol ids with an unrelated program so the fixture's symbols get different counter values.
    ts.createProgram({ rootNames: [path.join(DIR, 'types.ts')], options: { lib: ['lib.esnext.d.ts'], noEmit: true } }).getTypeChecker().getAmbientModules();
    const warm = deriveAll();
    expect(warm).to.deep.equal(cold);
    expect(hash(warm)).to.equal(hash(cold));
  });

  it('publishes no symbol-keyed property name', () => {
    const names = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(names);
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, child]) => [...(key.startsWith('__@') ? [key] : []), ...names(child)]);
    };
    expect(names(deriveAll())).to.deep.equal([]);
    expect(JSON.stringify(deriveAll())).to.not.include('__@');
  });
});
