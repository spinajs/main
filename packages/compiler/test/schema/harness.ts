import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgramFromTsconfig } from '../../src/program.js';
import { deriveSchema, DeriveOptions, DeriveResult, JsonSchema } from '../../src/schema/derive.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'schema');
let program: ts.Program | undefined;

function fixture(): { checker: ts.TypeChecker; file: ts.SourceFile } {
  program ??= createProgramFromTsconfig(path.join(FIXTURE_DIR, 'tsconfig.json')).program;
  const file = program.getSourceFile(path.join(FIXTURE_DIR, 'types.ts'));
  if (!file) throw new Error('fixture types.ts not in program');
  return { checker: program.getTypeChecker(), file };
}

export interface Derived extends DeriveResult {
  registry: Map<string, JsonSchema>;
}

/** Derives the schema of an exported type, class or enum of the fixture by its export name. */
export function derive(name: string, options: Partial<DeriveOptions> = {}): Derived {
  const { checker, file } = fixture();
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (!moduleSymbol) throw new Error('fixture has no module symbol');
  const symbol = checker.getExportsOfModule(moduleSymbol).find((s) => s.name === name);
  if (!symbol?.declarations?.length) throw new Error(`fixture export ${name} not found`);
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  const registry = new Map<string, JsonSchema>();
  const result = deriveSchema(checker, type, symbol.declarations[0], { idPrefix: 'fixture/', maxDepth: 20, ...options }, registry);
  return { ...result, registry };
}

export const ref = (name: string): JsonSchema => ({ $ref: `fixture/${name}` });
