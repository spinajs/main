import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenerateConfigTypes } from '../src/cli/GenerateConfigTypes.js';

const manifest = fileURLToPath(new URL('../../compiler/test/fixtures/app-basic/app.manifest.json', import.meta.url));

describe('generate:config-types', () => {
  let dir: string;
  let logged: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spinajs-config-types-'));
    logged = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function command(Type: typeof GenerateConfigTypes = GenerateConfigTypes): GenerateConfigTypes {
    const cmd = new Type();
    const record = (m: string) => logged.push(m);
    Object.defineProperty(cmd, 'Log', { value: { info: record, warn: record } });
    return cmd;
  }

  it('writes the ConfigPaths declaration for the requested modules', async function () {
    this.timeout(20000);
    const out = join(dir, 'nested', 'spinajs-config.d.ts');
    await command().execute({ manifest, out, modules: 'hooks' });

    const source = readFileSync(out, 'utf8');
    expect(source).to.include('interface ConfigPaths');
    expect(source).to.include(`'hooks.timeoutMs': number;`);
    expect(source).to.not.include(`'app.name'`);
    expect(logged.at(-1)).to.include(out);
  });

  it('logs a warning for a requested module the manifest lacks', async function () {
    this.timeout(20000);
    await command().execute({ manifest, out: join(dir, 'out.d.ts'), modules: 'hooks,nope' });
    expect(logged.some((l) => l.includes(`'nope'`))).to.equal(true);
  });

  it('explains how to install the compiler when it is missing', async () => {
    class Missing extends GenerateConfigTypes {
      protected override importCompiler(): never {
        throw Object.assign(new Error("Cannot find package '@spinajs/compiler' imported from cli"), { code: 'ERR_MODULE_NOT_FOUND' });
      }
    }
    let message = '';
    try {
      await command(Missing).execute({ manifest, out: join(dir, 'out.d.ts') });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.equal('install @spinajs/compiler to use generate:config-types');
  });
});
