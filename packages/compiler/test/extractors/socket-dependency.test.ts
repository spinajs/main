import { expect } from 'chai';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createContext, createProgramFromTsconfig, extractSocketControllers } from '../../src/index.js';

const write = (root: string, file: string, content: string): void => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};

describe('socket contracts imported from a dependency', () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'socket-dependency-'));
    write(root, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0' }));
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2021', module: 'node16', moduleResolution: 'node16', experimentalDecorators: true, strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['src/*.ts'] }));

    const dep = 'node_modules/@x/contracts';
    write(root, `${dep}/package.json`, JSON.stringify({ name: '@x/contracts', version: '1.0.0', types: 'lib/index.d.ts', spinajs: { manifest: 'lib/manifest.fragment.json' } }));
    write(root, `${dep}/lib/index.d.ts`, 'type C = { kind: "socket-contract"; id?: string };\nexport declare const NAMED: C;\nexport declare const PLAIN: C;\nexport declare const UNLISTED: C;\n');
    write(root, `${dep}/lib/manifest.fragment.json`, JSON.stringify({ socketContracts: [{ id: 'greet.v1', exportName: 'NAMED' }, { id: '@x/contracts:PLAIN' }] }));

    const bare = 'node_modules/bare';
    write(root, `${bare}/package.json`, JSON.stringify({ name: 'bare', version: '1.0.0', types: 'index.d.ts' }));
    write(root, `${bare}/index.d.ts`, 'export declare const BARE: { kind: "socket-contract" };\n');

    write(
      root,
      'src/app.ts',
      `import { NAMED, PLAIN, UNLISTED } from '@x/contracts';
import { BARE } from 'bare';
declare function SocketController(prefix?: string, options?: { contract?: unknown }): ClassDecorator;

@SocketController('named', { contract: NAMED })
export class NamedSocket {}

@SocketController('plain', { contract: PLAIN })
export class PlainSocket {}

@SocketController('unlisted', { contract: UNLISTED })
export class UnlistedSocket {}

@SocketController('bare', { contract: BARE })
export class BareSocket {}
`,
    );
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('takes the id from the dependency fragment by export name, else by package and export, and warns SOCK004 when it cannot', () => {
    const loaded = createProgramFromTsconfig(join(root, 'tsconfig.json'));
    const ctx = createContext(loaded, 'app', root);
    const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('app.ts'))!;

    expect(extractSocketControllers(ctx, file).map((c) => [c.className, c.contract])).to.deep.equal([
      ['NamedSocket', 'greet.v1'],
      ['PlainSocket', '@x/contracts:PLAIN'],
      ['UnlistedSocket', undefined],
      ['BareSocket', undefined],
    ]);
    const warnings = ctx.diagnostics.filter((d) => d.code === 'SOCK004');
    expect(warnings).to.have.length(2);
    expect(warnings[0].message).to.include("defineContract('<id>')").and.include('manifest fragment');
  });
});
