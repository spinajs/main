import 'mocha';
import { expect } from 'chai';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A process that never resolved an Orm, as the cli is: imports the built package (`npm run build` first), points the
 * upload connection at a SQLite file and resolves UploadStore. With `migrate`, a migrate-up run in a container of its own
 * creates the upload tables first, as a deploy step does.
 */
async function freshProcess(migrate: boolean): Promise<Record<string, unknown>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-upload-cli-'));
  const script = [
    "import { DI } from '@spinajs/di';",
    "import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';",
    "import '@spinajs/log';",
    "import { Orm } from '@spinajs/orm';",
    "import { migrateTestDatabase } from '@spinajs/orm/testing';",
    "import { SqliteOrmDriver } from '@spinajs/orm-sqlite';",
    "import { UploadStore } from '@spinajs/upload';",
    'class Config extends FrameworkConfiguration {',
    '  async resolve() {',
    '    await super.resolve();',
    "    this.Config.db = { DefaultConnection: 'cli', Connections: [{ Name: 'cli', Driver: 'orm-driver-sqlite', Filename: process.env.UPLOAD_CLI_DB }], Aliases: { upload: 'default' } };",
    '  }',
    '}',
    'DI.register(Config).as(Configuration);',
    "DI.register(SqliteOrmDriver).as('orm-driver-sqlite');",
    'await DI.resolve(Configuration);',
    ...(migrate ? ['const { orm: tool } = await migrateTestDatabase(DI.child());', 'await tool.dispose();'] : []),
    'const result = {};',
    'try {',
    '  const store = await DI.resolve(UploadStore);',
    '  result.orm = DI.get(Orm) !== undefined;',
    "  result.session = (await store.findSession('00000000-0000-0000-0000-000000000000')) ?? null;",
    '} catch (e) {',
    '  result.error = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);',
    '}',
    "console.log('RESULT ' + JSON.stringify(result));",
    'process.exit(0);',
  ].join('\n');

  try {
    const env = { ...process.env, UPLOAD_CLI_DB: path.join(dir, 'upload.sqlite') };
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, env });
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    expect(line, stdout).to.be.a('string');
    return JSON.parse(line!.slice('RESULT '.length)) as Record<string, unknown>;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('UploadStore in a process that has not resolved the Orm', function () {
  this.timeout(120_000);

  it('resolving the store resolves the Orm, and the store queries the upload tables', async () => {
    expect(await freshProcess(true)).to.deep.eq({ orm: true, session: null });
  });

  it('resolving the store on a database migrate-up never ran on refuses and names migrate-up', async () => {
    const result = await freshProcess(false);
    expect(result.error).to.match(/^PendingMigrationsException: .*npx spinajs migrate-up/);
  });
});
