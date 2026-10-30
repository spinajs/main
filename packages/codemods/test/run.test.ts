import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect } from 'chai';
import { runTransforms, V4_TRANSFORMS } from '../src/index.js';

const OLD = "import x from '@spinajs/http/lib/mjs/index.js';\nexport const y = x;\n";
const NEW = "import x from '@spinajs/http';\nexport const y = x;\n";

describe('runTransforms', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemods-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'node16', moduleResolution: 'node16' }, include: ['src'] }));
    writeFileSync(join(dir, 'src', 'a.ts'), OLD);
    writeFileSync(join(dir, 'src', 'clean.ts'), 'export const z = 1;\n');
    writeFileSync(join(dir, 'other', 'b.ts'), OLD);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('dry run reports changed files and writes nothing', async () => {
    const { changedFiles } = await runTransforms({ cwd: dir, transforms: V4_TRANSFORMS, dryRun: true });
    expect(changedFiles).to.deep.equal(['src/a.ts']);
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).to.equal(OLD);
  });

  it('rewrites files from the tsconfig', async () => {
    const { changedFiles } = await runTransforms({ cwd: dir, transforms: V4_TRANSFORMS, dryRun: false });
    expect(changedFiles).to.deep.equal(['src/a.ts']);
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).to.equal(NEW);
    expect(readFileSync(join(dir, 'other', 'b.ts'), 'utf8')).to.equal(OLD);
  });

  it('include globs replace the tsconfig file list', async () => {
    const { changedFiles } = await runTransforms({ cwd: dir, transforms: V4_TRANSFORMS, dryRun: false, include: ['other/**/*.ts'] });
    expect(changedFiles).to.deep.equal(['other/b.ts']);
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).to.equal(OLD);
  });

  it('is a no-op the second time', async () => {
    await runTransforms({ cwd: dir, transforms: V4_TRANSFORMS, dryRun: false });
    const { changedFiles } = await runTransforms({ cwd: dir, transforms: V4_TRANSFORMS, dryRun: false });
    expect(changedFiles).to.deep.equal([]);
  });

  it('fails clearly without a tsconfig', async () => {
    rmSync(join(dir, 'tsconfig.json'));
    let message = '';
    try {
      await runTransforms({ cwd: dir, transforms: V4_TRANSFORMS, dryRun: true });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.match(/tsconfig\.json/);
  });
});
