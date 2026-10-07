import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * An app that never imported the package root, so OidcBootstrapper never ran: the Configuration resolves, then the
 * controller dir scan imports OidcController, and a request reaches `GET /auth/oidc/:provider`.
 */
const APP_PROCESS = `
  const { DI } = await import('@spinajs/di');
  const { Configuration, FrameworkConfiguration } = await import('@spinajs/configuration');
  DI.setESMModuleSupport();
  const values = JSON.parse(process.env.LATE_SCHEMA_VALUES);
  class AppConfiguration extends FrameworkConfiguration {
    constructor() { super(); this.Env = 'development'; }
    loadSources() { this.Sources = []; }
    onLoad() { return JSON.parse(JSON.stringify(values)); }
  }
  DI.register(AppConfiguration).as(Configuration);
  await DI.resolve(Configuration);
  const { OidcController } = await import('./lib/mjs/controllers/OidcController.js');
  const { AuthnService, SessionIssuer } = await import('@spinajs/authn/contracts');
  DI.register(() => ({})).as(AuthnService);
  DI.register(() => ({})).as(SessionIssuer);
  const controller = new OidcController();
  const req = { get: () => undefined, socket: { remoteAddress: '127.0.0.1' }, query: {}, cookies: {} };
  try {
    const response = await controller.begin('corp', req);
    const { OidcProviders } = await import('./lib/mjs/providers.js');
    const providers = await DI.resolve(OidcProviders);
    console.log(JSON.stringify({ status: response.answer.status, providers: providers.options.providers.size, redirects: providers.options.redirects }));
  } catch (e) {
    console.log(JSON.stringify({ error: e.constructor.name, message: e.message, paths: (e.violations ?? []).map((v) => v.path) }));
  }
  process.exit(0);
`;

function appProcess(values: Record<string, unknown>): Record<string, any> {
  const env: NodeJS.ProcessEnv = { ...process.env, LATE_SCHEMA_VALUES: JSON.stringify(values) };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', APP_PROCESS], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const out = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(out[out.length - 1]) as Record<string, any>;
}

describe('OidcController found by a directory scan in an app where OidcBootstrapper never ran', function () {
  this.timeout(120000);

  it('answers with the authn.oidc schema defaults: an unknown provider gets the login failure answer, not a 500', () => {
    const r = appProcess({});
    expect(r.error, r.message).to.eq(undefined);
    expect(r.status).to.eq(401);
    expect(r.providers).to.eq(0);
  });

  it('refuses an authn.oidc the schema refuses: the read throws InvalidConfiguration naming the path', () => {
    const r = appProcess({ authn: { oidc: { providers: { corp: { clientId: 'x' } } } } });
    expect(r.error).to.eq('InvalidConfiguration');
    expect(r.paths.some((p: string) => p.startsWith('authn.oidc.providers.corp'))).to.eq(true);
  });
});
