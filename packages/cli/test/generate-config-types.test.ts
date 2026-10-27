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
  const logged: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spinajs-config-types-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function command(): GenerateConfigTypes {
    const cmd = new GenerateConfigTypes();
    Object.defineProperty(cmd, 'Log', { value: { info: (m: string) => logged.push(m) } });
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
});
