import { expect } from 'chai';
import { spawnSync } from 'node:child_process';

function report(fixture: string): { status: number | null; counts: unknown } {
  const run = spawnSync(process.execPath, ['scripts/report-diagnostics.mjs', `test/fixtures/${fixture}`, '--fail-on', 'SCH001'], { encoding: 'utf8' });
  const counts = run.stdout.split('\n').find((line) => line.startsWith('{"SCH'));
  return { status: run.status, counts: counts ? JSON.parse(counts) : undefined };
}

describe('report-diagnostics --fail-on', function () {
  this.timeout(60000);

  it('does not fail on info diagnostics of the code', () => {
    expect(report('report-info')).to.deep.equal({ status: 0, counts: { SCH001: { info: 1 } } });
  });
  it('fails on a warning of the code', () => {
    expect(report('report-warning')).to.deep.equal({ status: 1, counts: { SCH001: { warning: 1 } } });
  });
});
