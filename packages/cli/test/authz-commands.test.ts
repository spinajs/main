import 'mocha';
import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Cli } from '../src/index.js';
import { AuthzExport } from '../src/cli/AuthzExport.js';

const irPath = resolve(process.cwd(), '../authz-ir/test/fixtures/impact-3-3.ir.json');

class AuthzConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: { dirs: { cli: [resolve(process.cwd(), 'src/cli')] } },
    };
  }
}

const FOREIGN = `model
  schema 1.1

type user
type doc
  relations
    define editor: [user]
    define viewer: [user, user:*]
    define read: editor or viewer
`;

describe('authz:export and authz:import', function () {
  this.timeout(60000);

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'authz-cli-'));
    DI.clearCache();
    DI.register(AuthzConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (...args: string[]): Promise<void> => {
    DI.register(() => ['node', 'script.js', ...args]).as('__cli_argv_provider__');
    await DI.resolve(Cli);
  };

  it('exports the policy IR as an OpenFGA model', async () => {
    const out = join(dir, 'model.fga');
    await run('authz:export', '--ir', irPath, '--out', out, '--strict');
    const dsl = await readFile(out, 'utf8');
    expect(dsl).to.contain('type global # spina:$global').and.to.contain('define rbac_invoice_read: can_invoice_read or (clerk and owner)');
  });

  it('refuses a lossy export under --strict', async () => {
    const ir = JSON.parse(await readFile(irPath, 'utf8')) as { types: Record<string, { permissions: Record<string, unknown> }> };
    ir.types.invoice.permissions.custom = { opaque: 'custom model' };
    const lossy = join(dir, 'lossy.json');
    await writeFile(lossy, JSON.stringify(ir));
    const cmd = new AuthzExport();
    Object.defineProperty(cmd, 'Log', { value: { warn: () => undefined, info: () => undefined } });
    let error: unknown;
    try {
      await cmd.execute({ ir: lossy, format: 'openfga', strict: true });
    } catch (e) {
      error = e;
    }
    expect(String(error)).to.contain('--strict: invoice#custom: opaque custom model');
  });

  it('imports an OpenFGA model as an authz.rebac config fragment', async () => {
    const model = join(dir, 'model.fga');
    const out = join(dir, 'authz.rebac.json');
    await writeFile(model, FOREIGN);
    await run('authz:import', model, '--out', out);
    const config = JSON.parse(await readFile(out, 'utf8')) as { authz: { rebac: { namespaces: Record<string, unknown> } } };
    expect(config.authz.rebac.namespaces.doc).to.deep.equal({ relations: { editor: ['user'], viewer: ['user'] }, permissions: { read: { union: ['editor', 'viewer'] } } });
  });
});
