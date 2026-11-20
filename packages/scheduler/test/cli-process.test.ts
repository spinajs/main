import { expect } from 'chai';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const CHILD = fileURLToPath(new URL('./support/cli-child.ts', import.meta.url));

function runCli(
  env: Record<string, string>,
  ...args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', '--experimental-specifier-resolution=node', '--loader', 'ts-node/esm', CHILD, ...args],
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, ...env, TS_NODE_PROJECT: `${PACKAGE_DIR}tsconfig.json`, TS_NODE_TRANSPILE_ONLY: 'true' },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI in a fresh process', function () {
  this.timeout(90_000);

  it('runs scheduler:list when only the command files are loaded', async () => {
    const r = await runCli({}, 'scheduler:list', '--json');
    expect(r.code, r.stderr || r.stdout).to.eq(0);
    const list = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as Array<{ name: string; nextRunAt: string }>;
    expect(list.map((s) => s.name)).to.deep.eq(['cli-child']);
  });

  it('knows the built-in retention schedule when only the command files are loaded', async () => {
    const r = await runCli({ CLI_CHILD_RETENTION: '1' }, 'scheduler:list', '--json');
    expect(r.code, r.stderr || r.stdout).to.eq(0);
    const list = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as Array<{ name: string }>;
    expect(list.map((s) => s.name)).to.deep.eq(['cli-child', 'scheduler-retention']);
  });

  describe('on database files, with no Orm resolved before the command', () => {
    let dir: string;
    beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-scheduler-cli-'))));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('runs scheduler:list on a database a separate migrate-up run migrated: resolving the service boots the Orm', async () => {
      const r = await runCli({ CLI_CHILD_DB_DIR: dir }, 'scheduler:list', '--json');
      expect(r.code, r.stderr || r.stdout).to.eq(0);
      const list = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as Array<{ name: string }>;
      expect(list.map((s) => s.name)).to.deep.eq(['cli-child']);
    });

    it('refuses a database migrate-up never ran on and names migrate-up', async () => {
      const r = await runCli({ CLI_CHILD_DB_DIR: dir, CLI_CHILD_MIGRATE: '0' }, 'scheduler:list');
      expect(r.code, r.stdout).to.not.eq(0);
      expect(r.stderr).to.match(/^error: Database is not migrated: .*npx spinajs migrate-up/m);
    });
  });
});
