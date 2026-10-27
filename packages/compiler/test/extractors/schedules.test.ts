import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractSchedules } from '../../src/index.js';

describe('extractSchedules', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('schedule.ts'))!;

  it('name, class and literal options with emit as class name', () => {
    expect(extractSchedules(ctx, file)).to.deep.equal([
      {
        name: 'cleanup',
        className: 'CleanupSchedule',
        options: { cron: '0 3 * * *', timezone: 'UTC', runOn: 'leader', emit: 'Cleanup' },
        source: { file: 'src/schedule.ts', line: 7, col: 1, package: 'pkg-basic' },
      },
    ]);
  });
});
