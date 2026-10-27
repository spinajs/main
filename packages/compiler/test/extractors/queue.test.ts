import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractQueueMessages } from '../../src/index.js';

describe('extractQueueMessages', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const queue = loaded.sourceFiles.find((f) => f.fileName.endsWith('queue.ts'))!;
  const schedule = loaded.sourceFiles.find((f) => f.fileName.endsWith('schedule.ts'))!;

  it('@Event and @Job classes', () => {
    expect(extractQueueMessages(ctx, queue)).to.deep.equal([
      { className: 'UserCreated', kind: 'event', payload: { text: 'UserCreated', schema: 'spinajs/pkg-basic/UserCreated' }, options: { durable: true }, source: { file: 'src/queue.ts', line: 3, col: 1, package: 'pkg-basic' } },
    ]);
    expect(extractQueueMessages(ctx, schedule)).to.deep.equal([
      { className: 'Cleanup', kind: 'job', payload: { text: 'Cleanup', schema: 'spinajs/pkg-basic/Cleanup' }, options: { runAs: 'system' }, source: { file: 'src/schedule.ts', line: 4, col: 1, package: 'pkg-basic' } },
    ]);
  });
});
