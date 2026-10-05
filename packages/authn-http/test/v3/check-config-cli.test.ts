import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import { FakeIdentityStore, FakeStrategy, MemoryPasswordCredentialStore } from '@spinajs/authn-testing';

import { AuthnCheckConfig } from '../../src/cli/AuthnCheckConfig.js';

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
    const command = await child.resolve(AuthnCheckConfig);
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
    const values = sound({ http: { cookie: { secret: STRONG }, trustProxy: null, cors: { origins: 'https://app.example.com' } } });
    (values.authn as Values).local = { pepper: { secret: '', version: 1, previous: [{ secret: STRONG, version: 1 }] } };
    const r = await run(values, 'production');
    expect(r.lines.length).to.be.greaterThan(2);
    expect(r.exitCode).to.eq(1);
    noSecretIn(r.lines);
  });
});
