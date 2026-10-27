import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractSocketControllers, extractSocketContracts } from '../../src/index.js';

describe('socket extractors', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const socket = loaded.sourceFiles.find((f) => f.fileName.endsWith('socket.ts'))!;
  const contract = loaded.sourceFiles.find((f) => f.fileName.endsWith('contract.ts'))!;

  it('controller, commands, events', () => {
    const [docs] = extractSocketControllers(ctx, socket);
    expect(docs).to.deep.include({ id: 'pkg-basic:DocsSocket', className: 'DocsSocket', prefix: 'docs' });
    expect(docs.commands).to.deep.equal([
      { name: 'open', handler: 'open', payload: { text: 'OpenDoc' }, result: { text: 'DocOpened' }, options: { idempotent: true, ordered: 'client', timeoutMs: 5000 }, access: ['doc:read'], policies: [[{ type: 'AccessPolicy', options: ['route'] }]], source: { file: 'src/socket.ts', line: 11, col: 3, package: 'pkg-basic' } },
      { name: 'close', handler: 'close', payload: { text: 'OpenDoc' }, result: { text: 'void' }, options: {}, policies: [], source: { file: 'src/socket.ts', line: 15, col: 3, package: 'pkg-basic' } },
    ]);
    expect(docs.events).to.deep.equal([{ name: 'ping', payload: { text: 'Ping' } }]);
  });
  it('defineContract type argument', () => {
    const [c] = extractSocketContracts(ctx, contract);
    expect(c).to.deep.equal({
      id: 'pkg-basic:DOCS_CONTRACT',
      commands: { 'docs.open': { payload: { text: 'OpenDoc' }, result: { text: 'DocOpened' } }, 'docs.close': { payload: { text: 'OpenDoc' }, result: { text: 'void' } } },
      events: { 'docs.changed': { text: 'DocOpened' } },
      clientEvents: { 'docs.ping': { text: 'Ping' } },
      source: { file: 'src/contract.ts', line: 9, col: 14, package: 'pkg-basic' },
    });
  });
});
