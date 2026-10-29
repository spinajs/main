import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzePackage } from '../src/index.js';

const TSC7 = resolve('../../node_modules/typescript-7/lib/tsc.js');

describe('typescript 7 drift guard', function () {
  this.timeout(120000);

  it('the fixture type-checks under typescript-7 and the 5.9 analysis still matches the snapshot', async () => {
    const result = spawnSync(process.execPath, [TSC7, '--noEmit', '-p', 'test/fixtures/pkg-basic/tsconfig.json'], { encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).to.equal(0);

    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
    expect(fragment).to.deep.equal(JSON.parse(readFileSync('test/__snapshots__/pkg-basic.fragment.json', 'utf8')));
  });
});
