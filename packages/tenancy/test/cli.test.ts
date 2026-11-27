import 'mocha';
import { join } from 'node:path';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import '@spinajs/log';
import { Cli, CommanderError } from '@spinajs/cli';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { TenantRequired, TenantUnavailable, runInTenant, tenantScope } from '../src/index.js';
import { TENANT_CLI_HOOK_ORDER, TenantCliHook } from '../src/cli/hook.js';
import config from '../src/config/tenancy.js';
import { tenancyApp } from './support/app.js';
import { observed } from './support/cli-observed.js';

const TENANTS = [
  { id: 'acme', slug: 'acme', name: 'Acme', state: 'active', domains: [], settings: {} },
  { id: 'initech', slug: 'initech', name: 'Initech', state: 'active', domains: [], settings: {} },
  { id: 'globex', slug: 'globex', name: 'Globex', state: 'suspended', domains: [], settings: {} },
  { id: 'hooli', slug: 'hooli', name: 'Hooli', state: 'deleting', domains: [], settings: {} },
  { id: 'umbrella', slug: 'umbrella', name: 'Umbrella', state: 'deleted', domains: [], settings: {} },
  { id: 'wonka', slug: 'wonka', name: 'Wonka', state: 'provisioning', domains: [], settings: {} },
];

const ACME = { kind: 'tenant', tenant: { id: 'acme' } };

const hook = (): TenantCliHook => DI.resolve(TenantCliHook);
const scopeOf = (options: Record<string, unknown>) => hook().aroundExecute({ name: 'report', options }, async () => tenantScope());
const outcome = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'ran',
    (err: unknown) => err,
  );

describe('@spinajs/tenancy/cli', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await tenancyApp({ tenants: TENANTS });
  });

  afterEach(() => app.dispose());

  it('adds --tenant and --all-tenants to every command, each excluding the other, ahead of the default order', () => {
    expect(hook().options().map((o) => [o.flags, o.conflicts])).to.deep.eq([
      ['--tenant <id>', 'allTenants'],
      ['--all-tenants <reason>', 'tenant'],
    ]);
    expect(hook().order).to.eq(TENANT_CLI_HOOK_ORDER);
    expect(TENANT_CLI_HOOK_ORDER).to.be.lessThan(0);
  });

  it('runs a command inside the tenant it names once the registry admits it, the id compared as given', async () => {
    expect(await scopeOf({ tenant: 'acme' })).to.deep.eq(ACME);
    for (const [tenant, reason] of [
      ['nobody', 'unknown'],
      ['Not An Id', 'unknown'],
      ['ACME', 'unknown'],
      [' acme', 'unknown'],
      ['acme ', 'unknown'],
      ['globex', 'inactive'],
      ['hooli', 'inactive'],
      ['umbrella', 'inactive'],
      ['wonka', 'inactive'],
    ] as const) {
      const refused = await outcome(scopeOf({ tenant }));
      if (!(refused instanceof TenantUnavailable)) throw new Error(`expected TenantUnavailable for "${tenant}", got ${String(refused)}`);
      expect(refused.reason, tenant).to.eq(reason);
    }
  });

  it('runs a command across all tenants only with a reason, and with no scope without either option, whatever scope it was called in', async () => {
    expect(await scopeOf({ allTenants: ' ticket 4711 ' })).to.deep.eq({ kind: 'all', reason: 'ticket 4711' });
    expect(await outcome(scopeOf({ allTenants: '  ' }))).to.be.instanceOf(InvalidArgument);
    expect(await scopeOf({})).to.eq(undefined);
    expect(await runInTenant('initech', () => scopeOf({}))).to.eq(undefined);
  });

  it("lists the hook's folder in system.dirs.cli, which the CLI imports", () => {
    expect(config.system.dirs.cli.map((d) => d.replaceAll('\\', '/'))).to.satisfy((dirs: string[]) => dirs.every((d) => d.endsWith('/@spinajs/tenancy/lib/cli')));
  });
});

describe('@spinajs/tenancy/cli in a spinajs run', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({
      bootstrap: false,
      config: {
        tenancy: { tenants: TENANTS },
        system: { dirs: { cli: [join(process.cwd(), 'test', 'cli-commands')] } },
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      },
    });
    observed.runs = [];
    observed.preAction = [];
    observed.detached = undefined;
  });

  afterEach(() => app.dispose());

  /** One `spinajs` run, the next one in the same process and container. */
  async function spinajs(...argv: string[]): Promise<unknown> {
    app.container.register(() => ['node', 'spinajs', ...argv]).as('__cli_argv_provider__', { replace: true });
    app.container.uncache(Cli);
    return outcome(app.resolve(Cli));
  }

  it('refuses a command that needs a tenant and is given none, and never takes a default the command declares', async () => {
    expect(await spinajs('needs-tenant')).to.be.instanceOf(TenantRequired);
    expect(await spinajs('own-tenant')).to.eq('ran');
    expect(observed.runs).to.deep.eq([{ command: 'own-tenant:acme', atStart: undefined, afterAwait: undefined }]);
  });

  it('refuses an unknown, inactive or differently written tenant before the command runs', async () => {
    for (const tenant of ['nobody', 'ACME', ' acme', 'acme ', 'globex', 'hooli', 'umbrella', 'wonka']) {
      expect(await spinajs('scope', '--tenant', tenant), tenant).to.be.instanceOf(TenantUnavailable);
    }
    expect(await spinajs('scope', '--all-tenants', ' ')).to.be.instanceOf(InvalidArgument);
    expect(await spinajs('scope', '--tenant', 'acme', '--all-tenants', 'audit')).to.be.instanceOf(CommanderError);
    expect(observed.runs).to.deep.eq([]);
  });

  it('keeps the scope over the work the command starts, and the next command in the process starts with none', async () => {
    expect(await spinajs('scope', '--tenant', 'acme')).to.eq('ran');
    expect(await observed.detached).to.deep.eq(ACME);
    expect(await spinajs('--all-tenants', 'ticket 4711', 'scope')).to.eq('ran');
    expect(await spinajs('scope')).to.eq('ran');
    expect(await observed.detached).to.eq(undefined);
    expect(await runInTenant('initech', () => spinajs('scope'))).to.eq('ran');

    const ALL = { kind: 'all', reason: 'ticket 4711' };
    expect(observed.runs.map((r) => [r.atStart, r.afterAwait])).to.deep.eq([
      [ACME, ACME],
      [ALL, ALL],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    // commander's preAction hook runs before the action, outside the scope (README)
    expect(observed.preAction[0]).to.eq(undefined);
  });

  it('wraps a command whose action throws at once, and leaves no scope behind', async () => {
    const thrown = await spinajs('throws', '--tenant', 'acme');
    expect(String(thrown)).to.contain('"acme"');
    expect(await spinajs('scope')).to.eq('ran');
    expect(observed.runs[0].atStart).to.eq(undefined);
  });
});
