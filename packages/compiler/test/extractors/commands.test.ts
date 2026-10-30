import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractCommands } from '../../src/index.js';

describe('extractCommands', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('command.ts'))!;

  it('positional and object forms, options and arguments', () => {
    expect(extractCommands(ctx, file)).to.deep.equal([
      {
        name: 'basic:hello',
        className: 'HelloCommand',
        description: 'Say hello',
        options: [{ flags: '-l, --loud', description: 'Shout' }],
        arguments: [{ name: 'name', description: 'Who to greet' }],
        source: { file: 'src/command.ts', line: 3, col: 1, package: 'pkg-basic' },
      },
      {
        name: 'basic:bye',
        className: 'ByeCommand',
        description: 'Say bye',
        options: [],
        arguments: [],
        parent: 'basic:hello',
        source: { file: 'src/command.ts', line: 8, col: 1, package: 'pkg-basic' },
      },
    ]);
  });
});
