import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'chai';
import { Project } from 'ts-morph';
import { V4_TRANSFORMS, Transform } from '../../src/index.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const CASES: Array<[fixture: string, transform: string]> = [
  ['lib-mjs-imports', 'lib-mjs-imports'],
  ['esm-module-support', 'esm-module-support'],
  ['esm-module-support-inline', 'esm-module-support'],
  ['problem-json-note', 'problem-json-note'],
  ['untouched', 'lib-mjs-imports'],
  ['untouched', 'esm-module-support'],
  ['untouched', 'problem-json-note'],
];

function run(transform: Transform, source: string) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { experimentalDecorators: true } });
  const file = project.createSourceFile('input.ts', source);
  const changed = transform.apply(project, file);
  return { changed, text: file.getFullText() };
}

describe('v4 transforms (fixture pairs)', () => {
  it('registers the three transforms', () => {
    expect(V4_TRANSFORMS.map((t) => t.name)).to.deep.equal(['lib-mjs-imports', 'esm-module-support', 'problem-json-note']);
  });

  for (const [fixture, name] of CASES) {
    it(`${name} on ${fixture}`, () => {
      const transform = V4_TRANSFORMS.find((t) => t.name === name)!;
      const input = readFileSync(join(fixtures, fixture, 'input.ts'), 'utf8');
      const output = readFileSync(join(fixtures, fixture, 'output.ts'), 'utf8');

      const first = run(transform, input);
      expect(first.changed).to.equal(fixture !== 'untouched');
      expect(first.text).to.equal(output);

      const second = run(transform, output);
      expect(second.changed, 'idempotent').to.equal(false);
      expect(second.text).to.equal(output);
    });
  }

  it('every fixture directory has a case', () => {
    const covered = new Set(CASES.map(([f]) => f));
    expect(readdirSync(fixtures).filter((d) => !covered.has(d))).to.deep.equal([]);
  });
});
