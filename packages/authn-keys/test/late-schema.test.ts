import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A process like `spinajs authn:key-add`: the Configuration resolves first, then the cli dir scan imports the command
 * module and the registry it resolves. No package root, no Bootstrapper of @spinajs/authn.
 */
const CLI_PROCESS = `
  const { DI } = await import('@spinajs/di');
  const { Configuration, FrameworkConfiguration } = await import('@spinajs/configuration');
  DI.setESMModuleSupport();
  const values = JSON.parse(process.env.LATE_SCHEMA_VALUES);
  class CliProcessConfiguration extends FrameworkConfiguration {
    constructor() { super(); this.Env = 'development'; }
    loadSources() { this.Sources = []; }
    onLoad() { return JSON.parse(JSON.stringify(values)); }
  }
  DI.register(CliProcessConfiguration).as(Configuration);
  await DI.resolve(Configuration);
  await import('./lib/mjs/cli/AddKey.js');
  const { DefaultKeyRegistry } = await import('./lib/mjs/registry/registry.js');
  const registry = new DefaultKeyRegistry(null, null, null, []);
  try {
    console.log(JSON.stringify({ options: registry.options }));
  } catch (e) {
    console.log(JSON.stringify({ error: e.constructor.name, message: e.message, paths: (e.violations ?? []).map((v) => v.path) }));
  }
  process.exit(0);
`;

function cliProcess(values: Record<string, unknown>): Record<string, any> {
  const env: NodeJS.ProcessEnv = { ...process.env, LATE_SCHEMA_VALUES: JSON.stringify(values) };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CLI_PROCESS], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const out = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(out[out.length - 1]) as Record<string, any>;
}

describe('authn.keys in a CLI process that imports the command after the Configuration resolved', function () {
  this.timeout(120000);

  it('reads the authn.keys defaults of the authn schema through @Config', () => {
    const r = cliProcess({});
    expect(r.error, r.message).to.eq(undefined);
    expect(r.options).to.deep.eq({
      algorithms: ['EdDSA', 'ES256'],
      challenge: { ttlSeconds: 120, audience: null },
      assertion: { typ: 'spinajs-client+jwt', audience: null, maxLifetimeSeconds: 300, skewSeconds: 30 },
      httpSignature: { maxAgeSeconds: 300, skewSeconds: 30, requiredComponents: ['@method', '@target-uri', 'content-digest'] },
    });
  });

  it('refuses a value the schema refuses: the import succeeds, the read throws InvalidConfiguration naming the path', () => {
    const r = cliProcess({ authn: { keys: { challenge: { ttlSeconds: 7200 } } } });
    expect(r.error).to.eq('InvalidConfiguration');
    expect(r.paths).to.deep.eq(['authn.keys.challenge.ttlSeconds']);
    expect(r.message).to.contain('spinajs/authn.configuration.schema.json');
  });
});
