import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import { FakeIdentityStore, FakeStrategy, MemoryPasswordCredentialStore } from '@spinajs/authn-testing';

import { AuthnCheckConfig } from '../../src/cli/AuthnCheckConfig.js';
import { importIfInstalled } from '../../src/optional-import.js';

const PKG_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The provider packages are loaded in a child process below; this process keeps its registrations.
class InProcessCheckConfig extends AuthnCheckConfig {
  protected async loadProviders(): Promise<void> {
    return;
  }
}

const STRONG = 'k'.repeat(64);
const PUBLIC_SECRET = '1234adreewD';

type Values = Record<string, unknown>;

function sound(over: { http?: Values } = {}): Values {
  return {
    http: { cookie: { secret: STRONG }, trustProxy: 1, cors: { origins: ['https://app.example.com'] }, ...over.http },
    authn: {
      strategies: [{ name: 'local', service: 'N8aCliKitPassword' }],
      mfa: { steps: [], encryptionKey: { secret: STRONG } },
    },
  };
}

function configurationOf(values: Values, env: string | undefined): Class<Configuration> {
  const json = JSON.stringify(values);
  return class CheckConfigCliConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      if (env !== undefined) this.Env = env;
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

describe('authn:check-config (CLI)', function () {
  this.timeout(30000);

  const children: IContainer[] = [];
  const originalExitCode = process.exitCode;
  const savedEnv: Record<string, string | undefined> = {};
  let lines: string[];
  let consoleLog: typeof console.log;

  before(() => {
    for (const k of ['APP_ENV', 'NODE_ENV']) savedEnv[k] = process.env[k];
  });

  beforeEach(() => {
    process.exitCode = 0;
    lines = [];
    consoleLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  });

  afterEach(async () => {
    console.log = consoleLog;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const c of children.splice(0)) await c.dispose();
  });

  after(() => {
    process.exitCode = originalExitCode;
  });

  async function run(values: Values, env: string | undefined): Promise<{ lines: string[]; exitCode: typeof process.exitCode }> {
    const child = DI.RootContainer.child();
    children.push(child);
    child.register(configurationOf(values, env)).as(Configuration);
    await child.resolve(Configuration);
    const strategy = FakeStrategy.password({ identities: new FakeIdentityStore(), passwords: new MemoryPasswordCredentialStore() });
    child.register({ N8aCliKitPassword: () => strategy }.N8aCliKitPassword).as(AuthenticationStrategy);
    const command = await child.resolve(InProcessCheckConfig);
    await command.execute();
    const exitCode = process.exitCode;
    process.exitCode = 0;
    return { lines: [...lines], exitCode };
  }

  const noSecretIn = (out: string[]) => {
    const text = out.join('\n');
    expect(text).to.not.contain(STRONG);
    expect(text).to.not.contain(PUBLIC_SECRET);
  };

  it('prints a short "no findings" line and exits 0 for a sound production config', async () => {
    const r = await run(sound(), 'production');
    expect(r.lines).to.deep.eq(['authn:check-config: no findings']);
    expect(r.exitCode).to.eq(0);
  });

  it('SR-16 a public cookie secret without an app env: an error line per finding, exit code 1, no secret value', async () => {
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;
    const r = await run(sound({ http: { cookie: { secret: PUBLIC_SECRET } } }), undefined);
    expect(r.lines.some((l) => l.startsWith('warning env: '))).to.eq(true);
    expect(r.lines.some((l) => l.startsWith('error secrets: http.cookie.secret is the public default'))).to.eq(true);
    for (const l of r.lines) expect(l).to.match(/^(error|warning) (strategies|secrets|proxy|cors|env|mfa|legacy): \S/);
    expect(r.exitCode).to.eq(1);
    noSecretIn(r.lines);
  });

  it('an empty http.cors.origins is a warning line and exits 0', async () => {
    const r = await run(sound({ http: { cors: { origins: [] } } }), 'production');
    expect(r.lines).to.have.length(1);
    expect(r.lines[0]).to.match(/^warning cors: http\.cors\.origins is empty/);
    expect(r.exitCode).to.eq(0);
    noSecretIn(r.lines);
  });

  it('never prints a configured secret, whatever the findings', async () => {
    const values = sound({ http: { cookie: { secret: STRONG }, trustProxy: null, cors: { origins: [] } } });
    (values.authn as Values).local = { pepper: { secret: '', version: 2, previous: [{ secret: STRONG, version: 1 }] } };
    const r = await run(values, 'production');
    expect(r.lines.length).to.be.greaterThan(2);
    expect(r.exitCode).to.eq(1);
    noSecretIn(r.lines);
  });
});

/** A process like `spinajs authn:check-config`: the configuration, the files of the scanned cli dirs, the command. No package root. */
const CLI_PROCESS = `
  const { DI } = await import('@spinajs/di');
  const { Configuration, FrameworkConfiguration } = await import('@spinajs/configuration');
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  DI.setESMModuleSupport();
  const values = JSON.parse(process.env.N8A_CHECK_CONFIG_VALUES);
  class CliProcessConfiguration extends FrameworkConfiguration {
    constructor() { super(); this.Env = 'production'; }
    loadSources() { this.Sources = []; }
    onLoad() { return JSON.parse(JSON.stringify(values)); }
  }
  DI.register(CliProcessConfiguration).as(Configuration);
  await DI.resolve(Configuration);
  const dirs = [join(process.cwd(), 'lib', 'mjs', 'cli'), join(process.cwd(), '..', '..', 'node_modules', '@spinajs', 'authn-local', 'lib', 'mjs', 'cli')];
  for (const dir of dirs) for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) await import(pathToFileURL(join(dir, f)).href);
  const { AuthnCheckConfig } = await import(pathToFileURL(join(dirs[0], 'AuthnCheckConfig.js')).href);
  await (await DI.resolve(AuthnCheckConfig)).execute();
  console.log(JSON.stringify({ exitCode: process.exitCode ?? 0 }));
  process.exit(0);
`;

function cliProcess(strategies: unknown, authnExtra: Values = {}): { findings: string[]; exitCode: number; output: string } {
  const values = { ...sound(), authn: { strategies, mfa: { steps: [], encryptionKey: { secret: STRONG } }, ...authnExtra } };
  const env: NodeJS.ProcessEnv = { ...process.env, N8A_CHECK_CONFIG_VALUES: JSON.stringify(values) };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CLI_PROCESS], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const out = r.stdout.trim().split(/\r?\n/);
  const findings = out.filter((l) => /^(error|warning) [a-z]+: /.test(l) || l === 'authn:check-config: no findings');
  return { findings, output: r.stdout + r.stderr, exitCode: (JSON.parse(out[out.length - 1]) as { exitCode: number }).exitCode };
}

describe('authn:check-config in a process that loads only what the CLI loads', function () {
  this.timeout(120000);

  it('finds the strategy of an installed authn package: LocalPasswordStrategy gives no strategies error', () => {
    const r = cliProcess([{ name: 'local', service: 'LocalPasswordStrategy' }]);
    expect(r.findings).to.deep.eq(['authn:check-config: no findings']);
    expect(r.exitCode).to.eq(0);
  });

  it('still reports a strategy no installed package provides', () => {
    const r = cliProcess([{ name: 'x', service: 'N8aNoSuchStrategy' }]);
    expect(r.findings.filter((l) => l.startsWith('error strategies: '))).to.have.length(1);
    expect(r.exitCode).to.eq(1);
  });

  it('reports what the authn schema refuses although the schema was not applied at resolve time, never a secret', () => {
    const other = 'j'.repeat(64);
    const local = { pepper: { secret: STRONG, version: 1, previous: [{ secret: other, version: 1 }] } };
    const r = cliProcess([{ name: 'local', service: 'LocalPasswordStrategy' }], { local });
    expect(r.findings.some((l) => l.startsWith('error schema: authn.local.pepper.previous.0.version '))).to.eq(true);
    expect(r.exitCode).to.eq(1);
    expect(r.output).to.not.contain(STRONG).and.not.contain(other);
  });

  it('reports a non-array authn.strategies as a schema finding instead of crashing', () => {
    const r = cliProcess({ name: 'local', service: 'LocalPasswordStrategy' });
    expect(r.findings.some((l) => l.startsWith('error schema: authn.strategies '))).to.eq(true);
    expect(r.exitCode).to.eq(1);
  });
});

describe('importIfInstalled', () => {
  const failing = (e: object) => () => Promise.reject(Object.assign(new Error((e as { message: string }).message), e));

  it('answers undefined for a package that is not installed, in plain node (ESM and CJS builds)', function () {
    // ts-node's loader drops the error code, so the real errors are checked against the built package outside it.
    this.timeout(60000);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_OPTIONS;
    const esm = `const { importIfInstalled } = await import('./lib/mjs/optional-import.js'); console.log(String(await importIfInstalled('@spinajs/n8a-no-such-package')));`;
    const cjs = `require('./lib/cjs/optional-import.js').importIfInstalled('@spinajs/n8a-no-such-package').then((m) => console.log(String(m)), (e) => { console.error(e); process.exit(1); });`;
    for (const [inputType, body] of [['module', esm], ['commonjs', cjs]]) {
      const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '-e', body], { cwd: PKG_ROOT, encoding: 'utf8', env });
      expect(r.status, r.stderr).to.eq(0);
      expect(r.stdout.trim(), inputType).to.eq('undefined');
    }
  });

  it('answers undefined only when the named package itself is missing (ESM and CJS errors)', async () => {
    expect(await importIfInstalled('@x/y', failing({ code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find package '@x/y' imported from /app/a.js" }))).to.eq(undefined);
    expect(await importIfInstalled('@x/y', failing({ code: 'MODULE_NOT_FOUND', message: "Cannot find module '@x/y'\nRequire stack:\n- /app/a.js" }))).to.eq(undefined);
  });

  it('rethrows a missing dependency of the package and any other error', async () => {
    const cases = [
      failing({ code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find package 'dep' imported from /app/node_modules/@x/y/index.js" }),
      failing({ code: 'MODULE_NOT_FOUND', message: "Cannot find module 'dep'\nRequire stack:\n- /app/node_modules/@x/y/index.js" }),
      failing({ code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find package '@x/y-extra' imported from /app/a.js" }),
      failing({ message: 'boom at load' }),
    ];
    for (const load of cases) {
      const err = await importIfInstalled('@x/y', load).then(() => null, (e: Error) => e);
      expect(err, String(load)).to.be.instanceOf(Error);
    }
  });

  it('answers the module when it loads', async () => {
    const mod = { ok: true };
    expect(await importIfInstalled('@x/y', () => Promise.resolve(mod))).to.eq(mod);
  });
});
