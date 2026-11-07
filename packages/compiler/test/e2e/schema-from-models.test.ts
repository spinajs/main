import 'mocha';
import { expect } from 'chai';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installApp, runProbe } from './support/install-app.js';

const APP = resolve('test/fixtures/schema-verify-app');
const TMP = resolve('test/fixtures/.tmp-e2e-schema-verify');
const PROBE = resolve('test/e2e/support/probe.schema-diff.mjs');

const CONFIG = `
export default {
  logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '\${message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
  db: {
    DefaultConnection: 'default',
    // authz-orm and queue models name their own connections
    Aliases: { authz: 'default', 'authz-audit': 'default', queue: 'default' },
    StrictTableCheck: false,
    Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'default', Migration: { OnStartup: true, Table: 'orm_migrations' } }],
  },
};
`;

interface VerifyResult {
  error?: { name: string; message: string; stack: string };
  changes?: string[];
  diagnostics?: string[];
}

/** The program plan's "schema from models" milestone; it boots three packages, so it runs only when asked for. */
describe('schema from models: users, teams and authz-orm against their own migrations', function () {
  this.timeout(600_000);

  before(function () {
    if (process.env.SPINAJS_VERIFY_SCHEMA !== '1') this.skip();
    rmSync(TMP, { recursive: true, force: true });
  });

  after(() => {
    if (!process.env.E2E_KEEP) rmSync(TMP, { recursive: true, force: true });
  });

  it('migrates them, diffs their models against the result, and prints every difference', async () => {
    const root = await installApp({ app: APP, root: join(TMP, 'app'), config: CONFIG, probe: PROBE });
    const result = runProbe<VerifyResult>(root);
    process.stdout.write(`${[...(result.changes ?? []), ...(result.diagnostics ?? [])].join('\n')}\n`);
    expect(result.error).to.equal(undefined);
    expect((result.diagnostics ?? []).filter((d) => d.startsWith('error '))).to.deep.equal([]);
  });
});
