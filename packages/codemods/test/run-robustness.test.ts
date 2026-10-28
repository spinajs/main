import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect } from 'chai';
import type { SourceFile } from 'ts-morph';
import { runTransforms, V4_TRANSFORMS, Transform } from '../src/index.js';

const OLD = "import x from '@spinajs/http/lib/mjs/index.js';\nexport const y = x;\n";

describe('runTransforms robustness', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemods-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'node16', moduleResolution: 'node16' }, include: ['src'] }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not abort on a failing file and never saves it', async () => {
    writeFileSync(join(dir, 'src', 'a.ts'), OLD);
    writeFileSync(join(dir, 'src', 'b.ts'), OLD);
    const boom: Transform = {
      name: 'boom',
      description: 'fails on b.ts',
      apply(_project, file: SourceFile) {
        if (file.getBaseName() === 'b.ts') {
          throw new Error('kaboom');
        }
        return false;
      },
    };
    const result = await runTransforms({ cwd: dir, transforms: [...V4_TRANSFORMS, boom], dryRun: false });
    expect(result.changedFiles).to.deep.equal(['src/a.ts']);
    expect(result.failedFiles).to.have.length(1);
    expect(result.failedFiles[0]).to.include({ file: 'src/b.ts', transform: 'boom' });
    expect(result.failedFiles[0].error).to.contain('kaboom');
    expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf8')).to.equal(OLD);
  });

  it('visits JS and CJS files without allowJs', async () => {
    writeFileSync(join(dir, 'src', 'c.cjs'), "const m = typeof module !== 'undefined';\nmodule.exports = m ? 'x' : 'y';\n");
    writeFileSync(join(dir, 'src', 'd.js'), OLD);
    const { changedFiles, scannedFiles } = await runTransforms({ cwd: dir, transforms: V4_TRANSFORMS, dryRun: false });
    expect(changedFiles).to.deep.equal(['src/c.cjs', 'src/d.js']);
    expect(scannedFiles).to.equal(2);
  });

  it('rewrites a deep path to the package root only when the root re-exports the names', async () => {
    const pkg = join(dir, 'node_modules', '@spinajs', 'orm');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@spinajs/orm', type: 'module', exports: { '.': { types: './index.d.ts' } } }));
    writeFileSync(join(pkg, 'index.d.ts'), 'export declare const Orm: number;\n');
    writeFileSync(
      join(dir, 'src', 'e.ts'),
      "import { Orm } from '@spinajs/orm/lib/mjs/orm.js';\nimport { Other } from '@spinajs/orm/lib/mjs/other.js';\nexport const x = [Orm, Other];\n",
    );
    const { changedFiles, warnings } = await runTransforms({ cwd: dir, transforms: V4_TRANSFORMS, dryRun: false });
    const text = readFileSync(join(dir, 'src', 'e.ts'), 'utf8');
    expect(changedFiles).to.deep.equal(['src/e.ts']);
    expect(text).to.contain("import { Orm } from '@spinajs/orm';");
    expect(text).to.contain("from '@spinajs/orm/lib/mjs/other.js'");
    expect(warnings).to.have.length(1);
    expect(warnings[0].file).to.equal('src/e.ts');
  });
});
