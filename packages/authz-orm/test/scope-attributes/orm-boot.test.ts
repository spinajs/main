import * as chai from 'chai';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import 'mocha';

const expect = chai.expect;
const run = promisify(execFile);

/**
 * A process that never resolved an Orm, as the cli is: imports the built package (`npm run build` first), registers
 * DbScopeAttributeStore by class under both of its tokens and resolves them. With `migrate`, a migrate-up run in a
 * container of its own creates the tables first, as a deploy step does.
 */
async function freshProcess(migrate: boolean): Promise<Record<string, unknown>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-authz-orm-scope-'));
  const script = [
    "import { DI } from '@spinajs/di';",
    "import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';",
    "import '@spinajs/log';",
    "import { Orm } from '@spinajs/orm';",
    "import { migrateTestDatabase } from '@spinajs/orm/testing';",
    "import { SqliteOrmDriver } from '@spinajs/orm-sqlite';",
    "import { ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';",
    "import { DbScopeAttributeStore } from '@spinajs/authz-orm';",
    'class Config extends FrameworkConfiguration {',
    '  async resolve() {',
    '    await super.resolve();',
    "    this.Config.db = { DefaultConnection: 'cli', Connections: [{ Name: 'cli', Driver: 'orm-driver-sqlite', Filename: process.env.AUTHZ_ORM_DB }], Aliases: { authz: 'default' } };",
    '  }',
    '}',
    'DI.register(Config).as(Configuration);',
    "DI.register(SqliteOrmDriver).as('orm-driver-sqlite');",
    'DI.register(DbScopeAttributeStore).as(ScopeAttributeStore);',
    'DI.register(DbScopeAttributeStore).as(WritableScopeAttributeStore);',
    'await DI.resolve(Configuration);',
    ...(migrate ? ['const { orm: tool } = await migrateTestDatabase(DI.child());', 'await tool.dispose();'] : []),
    'const result = {};',
    'try {',
    '  const read = await DI.resolve(ScopeAttributeStore);',
    '  result.orm = DI.get(Orm) !== undefined;',
    '  result.same = read === (await DI.resolve(WritableScopeAttributeStore));',
    "  result.attributes = await read.get({ type: 'org', id: '7' });",
    '} catch (e) {',
    '  result.error = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);',
    '}',
    "console.log('RESULT ' + JSON.stringify(result));",
    'process.exit(0);',
  ].join('\n');

  try {
    const env = { ...process.env, AUTHZ_ORM_DB: path.join(dir, 'authz.sqlite') };
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, env });
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    expect(line, stdout).to.be.a('string');
    return JSON.parse(line!.slice('RESULT '.length)) as Record<string, unknown>;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('DbScopeAttributeStore registered by class, in a process that has not resolved the Orm', function () {
  this.timeout(120_000);

  it('resolving it resolves the Orm; both tokens give the one instance, which reads the table', async () => {
    expect(await freshProcess(true)).to.deep.eq({ orm: true, same: true, attributes: {} });
  });

  it('on a database migrate-up never ran on, resolving it refuses and names migrate-up', async () => {
    expect((await freshProcess(false)).error).to.match(/^PendingMigrationsException: .*npx spinajs migrate-up/);
  });
});
