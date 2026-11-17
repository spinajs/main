import 'mocha';
import { expect } from 'chai';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Cli } from '../src/index.js';
import { AuthzExport } from '../src/cli/AuthzExport.js';
import { AuthzImport } from '../src/cli/AuthzImport.js';

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

const OFFICE_IP = { params: { 'env.ip': 'string' }, expr: { attr: 'env.ip', eq: '10.0.0.1' } };
const ROW_OPEN = { params: { 'resource.status': 'string' }, expr: { attr: 'resource.status', eq: 'open' } };

const CONDITIONAL = `model
  schema 1.1

type user
type doc
  relations
    define viewer: [user, user with office_ip]
    define editor: [user with row_open]

# spina:caveat office_ip ${JSON.stringify(OFFICE_IP)}
condition office_ip(env_ip: string) {
  env_ip == "10.0.0.1"
}

# spina:caveat row_open ${JSON.stringify(ROW_OPEN)}
condition row_open(resource_status: string) {
  resource_status == "open"
}
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
    expect(config.authz.rebac).to.not.have.property('caveats');
  });

  it('imports conditional subject types with the caveats ReBAC can hold, and drops the others whole', async () => {
    const model = join(dir, 'conditional.fga');
    const out = join(dir, 'authz.rebac.json');
    await writeFile(model, CONDITIONAL);
    await run('authz:import', model, '--out', out);
    const config = JSON.parse(await readFile(out, 'utf8')) as { authz: { rebac: { namespaces: Record<string, unknown>; caveats: Record<string, unknown> } } };
    expect(config.authz.rebac.namespaces.doc).to.deep.equal({ relations: { viewer: ['user', 'user with office_ip'], editor: [] } });
    expect(config.authz.rebac.caveats).to.deep.equal({ office_ip: OFFICE_IP });
  });

  it('refuses a caveat ReBAC cannot hold under --strict', async () => {
    const model = join(dir, 'conditional.fga');
    await writeFile(model, CONDITIONAL);
    const cmd = new AuthzImport();
    const warned: string[] = [];
    Object.defineProperty(cmd, 'Log', { value: { warn: (m: string) => warned.push(m), info: () => undefined } });
    let error: unknown;
    try {
      await cmd.execute(model, { format: 'openfga', out: join(dir, 'strict.json'), strict: true });
    } catch (e) {
      error = e;
    }
    expect(String(error)).to.contain('authz:import --strict: 2 part(s)');
    expect(await readdir(dir)).to.deep.equal(['conditional.fga']);
    expect(warned).to.deep.equal(['authz:import: caveat row_open: ReBAC caveats read env.* and principal.* only, not resource.status', 'authz:import: doc#editor: {"type":"user","caveat":"row_open"} needs caveat row_open, which ReBAC cannot hold']);
  });
});
