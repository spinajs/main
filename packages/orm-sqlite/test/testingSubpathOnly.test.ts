import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import 'mocha';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('@spinajs/orm/testing as the only orm import', function () {
  this.timeout(30000);

  it('loads first and migrates a sqlite :memory: database', () => {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'testingSubpathOnly.mjs');
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });

    expect(run.stderr).to.not.include('before initialization');
    expect(run.status, run.stderr).to.equal(0);
    expect(run.stdout).to.include('{"executed":0}');
  });
});
