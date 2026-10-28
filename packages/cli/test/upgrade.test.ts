import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import { Upgrade } from '../src/cli/Upgrade.js';

chai.use(chaiAsPromised);

const OLD = "import x from '@spinajs/http/lib/mjs/index.js';\nexport const y = x;\n";

class Missing extends Upgrade {
  protected importCodemods(): ReturnType<Upgrade['loadCodemods']> {
    return Promise.reject(Object.assign(new Error("Cannot find package '@spinajs/codemods' imported from x"), { code: 'ERR_MODULE_NOT_FOUND' }));
  }
}

describe('upgrade command', () => {
  let dir: string;
  let cwd: string;
  let lines: string[];

  const command = <T extends Upgrade>(Type: new () => T): T => {
    const c = new Type();
    Object.defineProperty(c, 'Log', { value: { info: (m: string) => lines.push(m) } });
    return c;
  };

  beforeEach(() => {
    cwd = process.cwd();
    lines = [];
    dir = mkdtempSync(join(tmpdir(), 'upgrade-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'node16', moduleResolution: 'node16' }, include: ['src'] }));
    writeFileSync(join(dir, 'src', 'a.ts'), OLD);
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('--dry-run lists the files and writes nothing', async () => {
    await command(Upgrade).execute({ to: '4', dryRun: true });
    expect(lines[0]).to.equal('would change src/a.ts');
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).to.equal(OLD);
  });

  it('rewrites the files without --dry-run', async () => {
    await command(Upgrade).execute({ to: '4' });
    expect(lines[0]).to.equal('changed src/a.ts');
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).to.contain("from '@spinajs/http'");
  });

  it('refuses an unsupported major', async () => {
    await expect(command(Upgrade).execute({ to: '5' })).to.be.rejectedWith(/Unsupported target major "5"/);
  });

  it('asks to install @spinajs/codemods when it is missing', async () => {
    await expect(command(Missing).execute({ to: '4' })).to.be.rejectedWith(/Install @spinajs\/codemods/);
  });
});
