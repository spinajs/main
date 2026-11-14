import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import type { Diagnostic } from '@spinajs/manifest';
import { checkNPlusOne, createContext, createProgramFromTsconfig, isStrictOrm } from '../../src/index.js';

function analyze(fixture: string): { strict: boolean; diagnostics: Diagnostic[] } {
  const loaded = createProgramFromTsconfig(`test/fixtures/${fixture}/tsconfig.json`);
  const ctx = createContext(loaded, fixture, `test/fixtures/${fixture}`);
  for (const file of loaded.sourceFiles) checkNPlusOne(ctx, file);
  return { strict: isStrictOrm(loaded.program, loaded.checker), diagnostics: ctx.diagnostics.filter((d) => d.code === 'ORM101' || d.code === 'ORM102') };
}

const lineOf = (entry: string): number => Number(entry.split(' ')[1]);

/** The `// expect ORM10x` markers of a fixture file, as `code line`. */
function markers(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((text, i) => [...text.matchAll(/\/\/ expect (ORM10[12])/g)].map((m) => `${m[1]} ${i + 1}`))
    .sort((a, b) => lineOf(a) - lineOf(b));
}

describe('N+1 rules ORM101 and ORM102', () => {
  const CASES = 'test/fixtures/pkg-n-plus-one/src/cases.ts';
  const { strict, diagnostics } = analyze('pkg-n-plus-one');
  const inCases = diagnostics.filter((d) => d.source?.file === 'src/cases.ts');

  it('has 12 positive and 13 negative cases', () => {
    const text = readFileSync(CASES, 'utf8');
    expect(text.match(/export (async )?function positive\d\d/g)).to.have.length(12);
    expect(text.match(/export (async )?function negative\d\d/g)).to.have.length(13);
  });

  it('reports exactly the marked lines', () => {
    const found = inCases.map((d) => `${d.code} ${d.source?.line ?? 0}`).sort((a, b) => lineOf(a) - lineOf(b));
    expect(found).to.deep.equal(markers(CASES));
  });

  it('names the model and the relation path, nested paths included', () => {
    const messages = inCases.map((d) => d.message);
    expect(messages).to.include("relation Post.Owner.Company is read but never populated; add .populate('Owner.Company')");
    expect(messages).to.include('N+1: a query is awaited inside a loop; load the rows once before the loop ( whereIn, populate ) or batch them');
  });

  it('warns in a package that has not opted into strict columns', () => {
    expect(strict).to.equal(false);
    expect([...new Set(inCases.map((d) => d.severity))]).to.deep.equal(['warning']);
  });

  it('finds nothing in the flow fixture, which reads no relation in a loop', () => {
    expect(diagnostics.filter((d) => d.source?.file === 'src/flow.ts')).to.deep.equal([]);
  });
});

describe('N+1 rules in a package with OrmTypeRegistry.strictColumns', () => {
  const { strict, diagnostics } = analyze('pkg-n-plus-one-strict');

  it('detects strict mode from the registry augmentation', () => {
    expect(strict).to.equal(true);
  });

  it('reports errors', () => {
    expect(diagnostics.map((d) => `${d.severity} ${d.code} ${d.source?.line ?? 0}`)).to.deep.equal(['error ORM101 17', 'error ORM102 22']);
  });
});
